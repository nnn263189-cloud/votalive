import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAiRouter } from '../src/ai/router.js';

function toolCall(name, args, id = `call_${name}`) {
  return {
    id,
    name,
    arguments: args,
    raw: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  };
}

function mockGateway(overrides = {}) {
  return {
    configured: true,
    async chat() {
      return { text: 'resposta', toolCalls: [], usage: { input_tokens: 3, output_tokens: 1 } };
    },
    async *chatStream() {
      yield { type: 'delta', text: 'olá' };
      yield { type: 'done', usage: { input_tokens: 3, output_tokens: 1 } };
    },
    async generateImage() {
      return { images: [{ kind: 'base64', base64: 'aGVsbG8=', mimeType: 'image/png' }], text: '', usage: null, model: 'img', route: 'chat/completions', durationMs: 5 };
    },
    async inlineImages(images) {
      return images.map((image) => ({ dataUrl: `data:${image.mimeType};base64,${image.base64}` }));
    },
    async decisions({ input, questions }) {
      return {
        model: 'gpt-6-luna-decisions',
        answers: [{
          type: 'choice',
          name: questions[0]?.name,
          choice: 'accept',
          confidence: 0.7,
          probabilities: [{ value: 'accept', probability: 0.7 }],
        }],
        usage: { input_tokens: 20, output_tokens: 0, total_tokens: 20 },
        raw: { input, answers: [] },
      };
    },
    async listModels() {
      return ['gpt-6-luna', 'gpt-6-luna-decisions'];
    },
    ...overrides,
  };
}

async function startServer({ adminToken = '', gateway = mockGateway(), workspaceRoot } = {}) {
  const config = {
    apiKey: 'xpl_teste',
    baseUrl: 'https://api.experientiallabs.ai/v1',
    chatModel: 'gpt-6-luna',
    imageModel: 'gemini-3.1-flash-image',
    decisionsModel: 'gpt-6-luna-decisions',
    workspaceRoot,
    testCommand: 'echo testes-ok',
    timeoutMs: 5_000,
    maxAgentSteps: 4,
    testTimeoutMs: 10_000,
  };
  const app = express();
  const { router, sessionStore } = createAiRouter({ config, gateway, adminToken });
  app.use('/api/ai', router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sessionStore,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('sem token, as rotas de IA recusam o pedido', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  const server = await startServer({ adminToken: 'token-secreto-de-32-caracteres', workspaceRoot: root });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const denied = await fetch(`${server.baseUrl}/api/ai/status`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, 'unauthorized');

  const allowed = await fetch(`${server.baseUrl}/api/ai/status`, {
    headers: { 'x-admin-token': 'token-secreto-de-32-caracteres' },
  });
  assert.equal(allowed.status, 200);
  const status = await allowed.json();
  assert.equal(status.configured, true);
  assert.equal(status.decisionsModel, 'gpt-6-luna-decisions');
});

test('o status mostra que a chave falta quando ela não está configurada', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  const server = await startServer({
    workspaceRoot: root,
    gateway: mockGateway({ configured: false }),
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const status = await fetch(`${server.baseUrl}/api/ai/status`).then((response) => response.json());
  assert.equal(status.configured, false);

  const chat = await fetch(`${server.baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] }),
  });
  assert.equal(chat.status, 503);
  assert.match((await chat.json()).message, /EXPERIENTIAL_API_KEY/);
});

test('a rota de decisão devolve a resposta e o uso', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  const server = await startServer({ workspaceRoot: root });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch(`${server.baseUrl}/api/ai/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: 'evidência',
      name: 'review',
      questions: [{
        type: 'choice',
        name: 'review',
        instructions: 'aceitar?',
        choices: [{ value: 'accept' }, { value: 'review' }],
      }],
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.answer.choice, 'accept');
  assert.equal(payload.usage.input_tokens, 20);
  assert.equal(payload.model, 'gpt-6-luna-decisions');
});

test('a rota de decisão recusa payloads fora dos limites do gateway', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  const server = await startServer({ workspaceRoot: root });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch(`${server.baseUrl}/api/ai/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: 'evidência',
      questions: Array.from({ length: 33 }, (_value, index) => ({
        type: 'predicate',
        name: `q${index}`,
        instructions: 'é verdade?',
      })),
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /no máximo 32 perguntas/);
});

test('o agente propõe mudanças e só grava depois da aprovação', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  await writeFile(path.join(root, 'app.js'), 'export const valor = 1;\n', 'utf8');
  const gateway = mockGateway({
    async chat() {
      return {
        text: 'atualizei',
        toolCalls: [toolCall('write_file', { path: 'app.js', content: 'export const valor = 2;\n' })],
        usage: null,
      };
    },
  });
  const server = await startServer({ workspaceRoot: root, gateway });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const agent = await fetch(`${server.baseUrl}/api/ai/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'mude o valor' }),
  });
  assert.equal(agent.status, 200);
  const agentPayload = await agent.json();
  assert.equal(agentPayload.pending.length, 1);
  assert.equal(agentPayload.pending[0].path, 'app.js');
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 1;\n');

  const apply = await fetch(`${server.baseUrl}/api/ai/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: agentPayload.sessionId }),
  });
  assert.equal(apply.status, 200);
  const applied = await apply.json();
  assert.equal(applied.applied.length, 1);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 2;\n');
});

test('o navegador de arquivos lista o projeto e abre um arquivo', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  await writeFile(path.join(root, 'app.js'), 'export const valor = 1;\n', 'utf8');
  const server = await startServer({ workspaceRoot: root });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const files = await fetch(`${server.baseUrl}/api/ai/files`).then((response) => response.json());
  assert.ok(files.files.some((file) => file.path === 'app.js'));

  const file = await fetch(`${server.baseUrl}/api/ai/file?path=app.js`).then((response) => response.json());
  assert.match(file.content, /export const valor/);

  const escape = await fetch(`${server.baseUrl}/api/ai/file?path=../segredo`);
  assert.equal(escape.status, 400);
});

test('a rota de testes devolve a saída do comando', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-rotas-'));
  const server = await startServer({ workspaceRoot: root });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await fetch(`${server.baseUrl}/api/ai/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then((response) => response.json());

  assert.equal(result.ok, true);
  assert.match(result.output, /testes-ok/);
});
