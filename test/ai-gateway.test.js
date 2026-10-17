import assert from 'node:assert/strict';
import test from 'node:test';

import { ExperientialGateway, GatewayError } from '../src/ai/gateway.js';

function jsonResponse(body, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    statusText: 'status',
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  };
}

function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    if (!next) throw new Error('Resposta não preparada para o teste.');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

test('sem a chave, o gateway recusa antes de qualquer requisição', async () => {
  const gateway = new ExperientialGateway({ apiKey: '', fetchImpl: async () => { throw new Error('não deve chamar'); } });
  assert.equal(gateway.configured, false);
  await assert.rejects(() => gateway.chat({ messages: [{ role: 'user', content: 'oi' }] }), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.match(error.message, /EXPERIENTIAL_API_KEY/);
    return true;
  });
});

test('chat envia model + messages para /v1/chat/completions com o Bearer certo', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse({
      model: 'gpt-6-luna',
      choices: [{ message: { role: 'assistant', content: 'olá' } }],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const result = await gateway.chat({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'olá' }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.experientiallabs.ai/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer xpl_teste');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal, 'a requisição precisa de um sinal de timeout');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'olá' }]);
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.equal(result.text, 'olá');
  assert.equal(result.usage.input_tokens, 10);
});

test('erro HTTP traz status e corpo sem repetir a chamada', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse({ error: { message: 'modelo sem permissão' } }, { status: 403, ok: false }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  await assert.rejects(
    () => gateway.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'oi' }] }),
    (error) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, 403);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /modelo sem permissão/);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'não pode haver retry automático');
});

test('falha de transporte é propagada com contexto', async () => {
  const { fetchImpl } = recorder([new TypeError('fetch failed')]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  await assert.rejects(
    () => gateway.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'oi' }] }),
    (error) => {
      assert.ok(error instanceof GatewayError);
      assert.match(error.message, /Falha de transporte/);
      return true;
    },
  );
});

test('timeout vira erro com aviso de possível cobrança', async () => {
  const timeoutError = new Error('aborted');
  timeoutError.name = 'TimeoutError';
  const { fetchImpl } = recorder([timeoutError]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  await assert.rejects(
    () => gateway.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'oi' }] }),
    (error) => {
      assert.match(error.message, /Tempo esgotado/);
      assert.match(error.message, /já ter sido cobrada/);
      return true;
    },
  );
});

test('tool calls são normalizados com argumentos em JSON', async () => {
  const { fetchImpl } = recorder([
    jsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"server.js"}' },
          }],
        },
      }],
    }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const result = await gateway.chat({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'leia o server' }],
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'read_file');
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'server.js' });
});

test('decisions usa POST /v1/decisions com o modelo fixo', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse({
      model: 'gpt-6-luna-decisions',
      answers: [{ type: 'choice', name: 'review', choice: 'accept', confidence: 0.8 }],
      usage: { input_tokens: 42, total_tokens: 42 },
    }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const result = await gateway.decisions({
    input: 'evidência',
    questions: [{ type: 'choice', name: 'review', instructions: 'aceitar?', choices: [{ value: 'accept' }] }],
  });

  assert.equal(calls[0].url, 'https://api.experientiallabs.ai/v1/decisions');
  assert.equal(calls[0].body.model, 'gpt-6-luna-decisions');
  assert.equal(result.answers[0].choice, 'accept');
  assert.equal(result.usage.input_tokens, 42);
});

test('imagem: usa chat/completions com modalities e devolve base64 inline', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: 'aqui está',
          images: [{ b64_json: 'aGVsbG8=', mime_type: 'image/png' }],
        },
      }],
      usage: { input_tokens: 5, output_tokens: 0 },
    }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const result = await gateway.generateImage({ prompt: 'um gato', model: 'gemini-3.1-flash-image' });

  assert.equal(calls[0].url, 'https://api.experientiallabs.ai/v1/chat/completions');
  assert.deepEqual(calls[0].body.modalities, ['text', 'image']);
  assert.equal(result.route, 'chat/completions');
  assert.equal(result.images[0].kind, 'base64');

  const inlined = await gateway.inlineImages(result.images);
  assert.equal(inlined[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
});

test('imagem: cai para /v1/images/generations quando o chat não devolve imagem', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse({ choices: [{ message: { role: 'assistant', content: 'sem imagem' } }] }),
    jsonResponse({ data: [{ b64_json: 'aW1n', mime_type: 'image/png' }] }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const result = await gateway.generateImage({ prompt: 'um gato', model: 'gpt-image-1.5' });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.experientiallabs.ai/v1/images/generations');
  assert.equal(calls[1].body.prompt, 'um gato');
  assert.equal(result.route, 'images/generations');
  assert.equal(result.images[0].base64, 'aW1n');
});

test('imagem: quando o chat recusa o modelo, ainda tenta a rota de imagens', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse({ error: { message: 'modalities não suportado' } }, { status: 400, ok: false }),
    jsonResponse({ data: [{ url: 'https://exemplo.test/a.png' }] }),
  ]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const result = await gateway.generateImage({ prompt: 'um gato', model: 'gpt-image-1.5' });

  assert.equal(calls.length, 2);
  assert.equal(result.images[0].kind, 'url');
  assert.equal(result.images[0].url, 'https://exemplo.test/a.png');
});

test('listModels lê GET /v1/models', async () => {
  const { calls, fetchImpl } = recorder([jsonResponse({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-luna-decisions' }] })]);
  const gateway = new ExperientialGateway({ apiKey: 'xpl_teste', fetchImpl });

  const models = await gateway.listModels();

  assert.equal(calls[0].url, 'https://api.experientiallabs.ai/v1/models');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-6-luna-decisions']);
});
