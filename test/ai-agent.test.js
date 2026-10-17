import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyPending, discardPending, executeTool, listPending, runAgent } from '../src/ai/agent.js';

function toolCall(name, args, id = `call_${name}`) {
  return {
    id,
    name,
    arguments: args,
    raw: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  };
}

function mockGateway(replies) {
  const queue = [...replies];
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      calls.push(messages);
      const reply = queue.shift();
      if (!reply) throw new Error('Sem respostas preparadas para o mock.');
      return { text: reply.text || '', toolCalls: reply.toolCalls || [], usage: reply.usage || null };
    },
  };
}

async function temporaryProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'votalive-agente-'));
  await writeFile(path.join(root, 'app.js'), 'export const valor = 1;\n', 'utf8');
  return root;
}

function makeWorkspace(root) {
  return {
    root,
    testCommand: 'node --version',
    resolveAbsolute: (relative) => path.resolve(root, relative),
  };
}

test('o agente lê arquivos e propõe mudanças sem gravar no disco', async () => {
  const root = await temporaryProject();
  try {
    const gateway = mockGateway([
      { toolCalls: [toolCall('list_files', {})] },
      { toolCalls: [toolCall('read_file', { path: 'app.js' })] },
      { toolCalls: [toolCall('write_file', { path: 'app.js', content: 'export const valor = 2;\n', reason: 'novo valor' })] },
      { text: 'Pronto: atualizei o valor.' },
    ]);
    const session = { id: 's1', history: [], pending: new Map() };

    const result = await runAgent({
      gateway,
      workspace: makeWorkspace(root),
      session,
      prompt: 'mude o valor para 2',
      model: 'gpt-6-luna',
    });

    const pending = listPending(session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].path, 'app.js');
    assert.equal(pending[0].action, 'write');
    assert.match(pending[0].diff, /\+export const valor = 2;/);
    assert.match(result.steps.at(-1).text, /atualizei o valor/);

    // Nada foi gravado: o disco ainda tem o conteúdo antigo.
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 1;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aplicar as mudanças pendentes grava o arquivo e limpa a fila', async () => {
  const root = await temporaryProject();
  try {
    const session = { id: 's1', history: [], pending: new Map() };
    const result = await executeTool({
      call: toolCall('write_file', { path: 'app.js', content: 'export const valor = 2;\n' }),
      workspace: makeWorkspace(root),
      session,
    });

    assert.equal(result.ok, true);
    assert.equal(result.staged, true);
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 1;\n');

    const applied = await applyPending(makeWorkspace(root), session);
    assert.equal(applied.applied.length, 1);
    assert.equal(applied.failed.length, 0);
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 2;\n');
    assert.equal(listPending(session).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('o agente não consegue escrever fora da pasta do projeto', async () => {
  const root = await temporaryProject();
  try {
    const session = { id: 's1', history: [], pending: new Map() };
    const result = await executeTool({
      call: toolCall('write_file', { path: '../fora.js', content: 'x' }),
      workspace: makeWorkspace(root),
      session,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /não pode sair/);
    assert.equal(listPending(session).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit_file só aceita quando o trecho existe e compõe com o pending', async () => {
  const root = await temporaryProject();
  try {
    const session = { id: 's1', history: [], pending: new Map() };
    const workspace = makeWorkspace(root);

    const missing = await executeTool({
      call: toolCall('edit_file', { path: 'app.js', find: 'não existe', replace: 'x' }),
      workspace,
      session,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Trecho não encontrado/);

    const first = await executeTool({
      call: toolCall('edit_file', { path: 'app.js', find: 'valor = 1', replace: 'valor = 2' }),
      workspace,
      session,
    });
    assert.equal(first.ok, true);

    const second = await executeTool({
      call: toolCall('edit_file', { path: 'app.js', find: 'valor = 2', replace: 'valor = 3' }),
      workspace,
      session,
    });
    assert.equal(second.ok, true);

    await applyPending(workspace, session);
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 3;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('descartar pendências limpa a fila sem tocar no disco', async () => {
  const root = await temporaryProject();
  try {
    const session = { id: 's1', history: [], pending: new Map() };
    await executeTool({
      call: toolCall('write_file', { path: 'app.js', content: 'outro\n' }),
      workspace: makeWorkspace(root),
      session,
    });
    assert.equal(listPending(session).length, 1);

    const discarded = discardPending(session);
    assert.deepEqual(discarded, ['app.js']);
    assert.equal(listPending(session).length, 0);
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 1;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a remoção de arquivo fica pendente até a aprovação', async () => {
  const root = await temporaryProject();
  try {
    const session = { id: 's1', history: [], pending: new Map() };
    const workspace = makeWorkspace(root);
    await executeTool({ call: toolCall('delete_file', { path: 'app.js' }), workspace, session });

    assert.equal(listPending(session)[0].action, 'delete');
    assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const valor = 1;\n');

    await applyPending(workspace, session);
    await assert.rejects(() => readFile(path.join(root, 'app.js'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run_tests usa o comando configurado e devolve a saída', async () => {
  const root = await temporaryProject();
  try {
    const session = { id: 's1', history: [], pending: new Map() };
    const result = await executeTool({
      call: toolCall('run_tests', {}),
      workspace: makeWorkspace(root),
      session,
      testCommand: 'echo testes-ok',
    });

    assert.equal(result.ok, true);
    assert.match(result.output, /testes-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
