import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitForMessage(socket, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', listener);
      reject(new Error('Tempo esgotado aguardando mensagem WebSocket.'));
    }, timeoutMs);
    const listener = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WebSocket não abriu.')), 3_000);
    socket.once('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'hello') return;
      clearTimeout(timer);
      resolve({ socket, hello: message });
    });
  });
}

test('servidor inicia, protege comandos e restaura o placar ao reconectar', { timeout: 15_000 }, async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'votalive-test-'));
  const stateFile = path.join(temporaryDirectory, 'state.json');
  const token = 'token-de-integracao-com-32-caracteres';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      ADMIN_TOKEN: token,
      STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stopped = false;
  let logs = '';
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    if (!stopped) {
      child.kill('SIGTERM');
      await exitPromise;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Servidor não iniciou. Logs: ${logs}`)), 6_000);
    const inspect = (chunk) => {
      logs += String(chunk);
      const match = logs.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Servidor encerrou antes de iniciar (${code}). Logs: ${logs}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.connection, 'idle');
  assert.equal(health.username, null);
  assert.equal(health.message, null);
  const page = await fetch(baseUrl).then((response) => response.text());
  assert.match(page, /id="totalParticipants"/);
  assert.match(page, /src="app\.js"/);

  const first = await openSocket(`ws://127.0.0.1:${port}`);
  assert.equal(first.hello.authRequired, true);
  assert.equal(first.hello.authorized, false);

  first.socket.send(JSON.stringify({ type: 'simulate', giftKey: 'rose' }));
  const denied = await waitForMessage(first.socket, (message) => message.type === 'command_error');
  assert.equal(denied.code, 'unauthorized');

  first.socket.send(JSON.stringify({ type: 'auth', token }));
  assert.equal(
    (await waitForMessage(first.socket, (message) => message.type === 'auth_result')).ok,
    true,
  );
  first.socket.send(JSON.stringify({ type: 'simulate', giftKey: 'rose' }));
  const gift = await waitForMessage(first.socket, (message) => message.type === 'gift');
  assert.equal(gift.state.scores.A, 10);
  assert.equal(gift.state.totalGifts, 1);
  assert.equal(gift.state.totalParticipants, 1);

  first.socket.close();
  await new Promise((resolve) => first.socket.once('close', resolve));
  const second = await openSocket(`ws://127.0.0.1:${port}`);
  assert.equal(second.hello.state.scores.A, 10);
  assert.equal(second.hello.state.totalGifts, 1);
  second.socket.close();
  await new Promise((resolve) => second.socket.once('close', resolve));

  child.kill('SIGTERM');
  const exitCode = await exitPromise;
  stopped = true;
  assert.equal(exitCode, 0, logs);

  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted.scores.A, 10);
  assert.equal(persisted.totalGifts, 1);
});
