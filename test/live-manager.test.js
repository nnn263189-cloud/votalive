import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ControlEvent, WebcastEvent } from 'tiktok-live-connector';
import {
  applyEulerFallbackSetting,
  connectorErrorCodes,
  connectorErrorDetails,
  connectorErrorMessage,
  eulerFallbackDisabled,
  LiveManager,
  normalizeUsername,
  resolveSignApiKey,
} from '../src/live-manager.js';

class FakeConnection extends EventEmitter {
  constructor({ roomId = 'room-1', error = null } = {}) {
    super();
    this.roomId = roomId;
    this.error = error;
    this.disconnected = false;
  }

  async connect() {
    if (this.error) throw this.error;
    const state = { roomId: this.roomId };
    this.emit(ControlEvent.CONNECTED, state);
    return state;
  }

  async disconnect() {
    this.disconnected = true;
  }
}

const quietLogger = { log() {}, warn() {}, error() {} };

test('valida e limpa o username', () => {
  assert.equal(normalizeUsername(' @nome.live '), 'nome.live');
  assert.throws(() => normalizeUsername('nome com espaço'), /Username inválido/);
  assert.throws(() => normalizeUsername(''), /Informe/);
});

test('extrai a mensagem do formato de erro do conector 2.5.0', () => {
  assert.equal(connectorErrorMessage({ info: 'falhou', exception: new Error('detalhe') }), 'detalhe');
  assert.equal(connectorErrorMessage({ message: 'offline' }), 'offline');
});

test('lê a chave de assinatura do ambiente sem espaços', () => {
  assert.equal(resolveSignApiKey({ SIGN_API_KEY: '  chave-euler  ' }), 'chave-euler');
  assert.equal(resolveSignApiKey({ SIGN_API_KEY: '   ' }), null);
  assert.equal(resolveSignApiKey({}), null);
  assert.equal(resolveSignApiKey(undefined), null);
});

test('liga a desativação da rota Euler somente com a variável explícita', () => {
  const routeConfig = { skipFetchRoomIdFromEulerRoute: false };
  assert.equal(eulerFallbackDisabled({ TIKTOK_SKIP_EULER_FALLBACK: 'TRUE' }), true);
  assert.equal(eulerFallbackDisabled({ TIKTOK_SKIP_EULER_FALLBACK: 'false' }), false);
  assert.equal(eulerFallbackDisabled({}), false);

  assert.equal(applyEulerFallbackSetting({ enabled: true, routeConfig }), true);
  assert.equal(routeConfig.skipFetchRoomIdFromEulerRoute, true);
  assert.equal(applyEulerFallbackSetting({ enabled: false, routeConfig }), false);
  assert.equal(routeConfig.skipFetchRoomIdFromEulerRoute, false);
});

test('classifica a falha da Euler Stream com dica acionável', () => {
  const euler = connectorErrorDetails(
    new Error(
      'Failed to retrieve Room ID from Euler Stream, which was made as a last resort due to the previous methods failing. This happened due to a >>lack of permission<< for you to use Euler Stream\'s (https://www.eulerstream.com) fallback method.',
    ),
  );
  assert.equal(euler.kind, 'signing');
  assert.match(euler.hint, /SIGN_API_KEY/);

  const rateLimit = connectorErrorDetails({ message: 'Rate limit exceeded, retry after 60s' });
  assert.equal(rateLimit.kind, 'rate_limit');

  const offline = connectorErrorDetails({ message: "The requested user isn't online :(" });
  assert.equal(offline.kind, 'offline');

  const network = connectorErrorDetails(new Error('connect ETIMEDOUT 1.2.3.4:443'));
  assert.equal(network.kind, 'network');

  const unknown = connectorErrorDetails(new Error('algo inesperado'));
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.hint, null);
  assert.deepEqual(unknown.codes, ['Error']);
});

test('resume as causas sem repetir nomes genéricos de erro', () => {
  assert.deepEqual(connectorErrorCodes({ name: 'Error', config: { requestErrs: [{ code: 'ECONNRESET' }] } }), [
    'ECONNRESET',
  ]);
  assert.deepEqual(connectorErrorCodes(new Error('sem detalhes')), ['Error']);
});

test('olha as causas agregadas da rota composta de descoberta da sala', () => {
  const composite = (requestErrs) => ({
    name: 'InvalidResponseCompositeError',
    message: 'Failed to retrieve Room ID from all sources.',
    config: { routeId: 'fetchRoomIdRoute', requestErrs },
  });

  const euler = connectorErrorDetails(composite([
    {
      name: 'InvalidResponseError',
      message:
        'Failed to retrieve Room ID from Euler Stream ... due to a >>lack of permission<< for you to use Euler Stream\'s fallback method.',
    },
    { name: 'RequestError', code: 'ECONNRESET', message: 'connect ECONNRESET 1.2.3.4:443' },
  ]));
  assert.equal(euler.message, 'Failed to retrieve Room ID from all sources.');
  assert.equal(euler.kind, 'signing');
  assert.match(euler.hint, /SIGN_API_KEY/);
  assert.deepEqual(euler.codes, ['InvalidResponseCompositeError', 'InvalidResponseError', 'ECONNRESET']);

  const network = connectorErrorDetails(composite([
    { name: 'RequestError', code: 'ECONNRESET', message: 'connect ECONNRESET 1.2.3.4:443' },
  ]));
  assert.equal(network.kind, 'network');
  assert.match(network.hint, /não alcançou/);

  const offline = connectorErrorDetails(composite([
    { name: 'UserOfflineError', message: "The requested user isn't online :(" },
  ]));
  assert.equal(offline.kind, 'offline');

  const generic = connectorErrorDetails(composite([]));
  assert.equal(generic.kind, 'room_id');
  assert.match(generic.hint, /@ está correto/);
  assert.deepEqual(connectorErrorCodes(composite([])), ['InvalidResponseCompositeError']);
});

test('encaminha a chave de assinatura para a fábrica de conexões', async () => {
  const calls = [];
  const manager = new LiveManager({
    signApiKey: 'chave-de-teste',
    connectionFactory: (username, options) => {
      calls.push({ username, options });
      return new FakeConnection();
    },
    logger: quietLogger,
  });

  await manager.connect('criador');
  assert.deepEqual(calls, [{ username: 'criador', options: { signApiKey: 'chave-de-teste' } }]);
  await manager.close();
});

test('expõe tipo e dica da falha de assinatura no status', async () => {
  const manager = new LiveManager({
    connectionFactory: () => new FakeConnection({ error: new Error("isn't online :(") }),
    logger: quietLogger,
  });
  await manager.connect('criador');

  const status = manager.getStatus();
  assert.equal(status.phase, 'error');
  assert.equal(status.kind, 'offline');
  assert.match(status.hint, /não estava ao vivo/);
  assert.match(status.message, /online/);
  assert.deepEqual(status.codes, ['Error']);
});

test('preserva tipo e dica da falha ao agendar reconexão', async () => {
  const manager = new LiveManager({ reconnectDelays: [5_000], logger: quietLogger });
  manager.username = 'criador';
  manager.shouldReconnect = true;

  manager.scheduleReconnect(manager.intentId, {
    message: 'Euler Stream: unauthorized 401',
    kind: 'signing',
    hint: 'Defina SIGN_API_KEY no serviço.',
  });

  const status = manager.getStatus();
  assert.equal(status.phase, 'reconnecting');
  assert.equal(status.attempt, 1);
  assert.equal(status.kind, 'signing');
  assert.match(status.hint, /SIGN_API_KEY/);
  await manager.close();
});

test('reconexão que falha por assinatura mantém a dica no status', async () => {
  let attempt = 0;
  const manager = new LiveManager({
    connectionFactory: () => {
      attempt += 1;
      return attempt === 1
        ? new FakeConnection({ roomId: 'sala' })
        : new FakeConnection({ error: new Error('Euler Stream: premium feature required') });
    },
    reconnectDelays: [10],
    logger: quietLogger,
  });

  await manager.connect('criador');
  assert.equal(manager.getStatus().phase, 'connected');

  manager.connection.emit(ControlEvent.DISCONNECTED, { code: 1006, reason: 'queda' });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(manager.getStatus().phase, 'reconnecting');
  assert.ok(manager.getStatus().attempt >= 2);
  assert.equal(manager.getStatus().kind, 'signing');
  assert.match(manager.getStatus().hint, /SIGN_API_KEY/);
  await manager.close();
});

test('conecta, encaminha presentes e informa a sala', async () => {
  const fake = new FakeConnection({ roomId: 'abc' });
  const statuses = [];
  const connected = [];
  const gifts = [];
  const manager = new LiveManager({
    connectionFactory: () => fake,
    onStatus: (status) => statuses.push(status),
    onConnected: (event) => connected.push(event),
    onGift: (gift) => gifts.push(gift),
    logger: quietLogger,
  });

  await manager.connect('@criador');
  fake.emit(WebcastEvent.GIFT, { giftId: '1' });

  assert.equal(manager.getStatus().phase, 'connected');
  assert.equal(manager.getStatus().roomId, 'abc');
  assert.equal(connected.length, 1);
  assert.deepEqual(gifts, [{ giftId: '1' }]);
  assert.ok(statuses.some((status) => status.phase === 'connecting'));
  assert.ok(statuses.some((status) => status.phase === 'connected'));

  await manager.close();
  assert.equal(fake.disconnected, true);
});

test('expõe erro inicial e permite uma nova tentativa pelo painel', async () => {
  const warnings = [];
  const manager = new LiveManager({
    connectionFactory: () => new FakeConnection({ error: new Error('LIVE offline') }),
    onConnectorError: (event) => warnings.push(event.message),
    logger: quietLogger,
  });

  await manager.connect('criador');
  assert.equal(manager.getStatus().phase, 'error');
  assert.match(manager.getStatus().message, /offline/);
  assert.deepEqual(warnings, ['LIVE offline']);
});

test('preserva o resultado e marca status quando a LIVE termina', async () => {
  const fake = new FakeConnection();
  let ended = 0;
  const manager = new LiveManager({
    connectionFactory: () => fake,
    onStreamEnd: () => { ended += 1; },
    logger: quietLogger,
  });

  await manager.connect('criador');
  fake.emit(WebcastEvent.STREAM_END, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ended, 1);
  assert.equal(manager.getStatus().phase, 'ended');
  assert.match(manager.getStatus().message, /preservado/);
});
