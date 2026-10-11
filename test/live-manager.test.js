import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  ControlEvent,
  PremiumFeatureError,
  SignatureRateLimitError,
  TikTokLiveConnection,
  WebcastEvent,
} from 'tiktok-live-connector';
import {
  applyEulerFallbackSetting,
  buildConnectionOptions,
  connectorErrorCodes,
  connectorErrorDetails,
  connectorErrorMessage,
  eulerFallbackDisabled,
  extendedGiftInfoEnabled,
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

/** Runs `fn` with temporary env values (`undefined` removes the variable). */
function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(values);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/**
 * Stand-in for the Euler Stream API client, injected into the REAL connector
 * (`eulerApiInstance`) so the connect flow runs without any network access.
 * `signTikTokUrl` is the URL-signing route that `gift/list/` goes through;
 * `fetchWebcastURL` is the WebSocket-signing route.
 */
function fakeEulerClient({ signUrlResponse, webSocketResponse }) {
  const calls = { signUrl: [], webSocket: 0 };
  const client = {
    general: {
      async signTikTokUrl(body) {
        calls.signUrl.push(body.url);
        return signUrlResponse;
      },
    },
    rooms: {
      async fetchWebcastURL() {
        calls.webSocket += 1;
        return webSocketResponse;
      },
    },
  };
  return { client, calls };
}

// Realistic sign-server answers. Messages must be at least 19 characters or the
// connector's own message box formatter throws a RangeError.
const SIGN_URL_DENIED = {
  status: 403,
  data: { message: 'This endpoint requires a Business plan.' },
  headers: {},
};
const WEBSOCKET_PLAN_DENIED = {
  status: 402,
  data: Buffer.from(JSON.stringify({ message: 'Your plan does not include WebSocket signing.' })),
  headers: {},
};

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
    extendedGiftInfo: false,
    connectionFactory: (username, options) => {
      calls.push({ username, options });
      return new FakeConnection();
    },
    logger: quietLogger,
  });

  await manager.connect('criador');
  assert.deepEqual(calls, [
    { username: 'criador', options: { signApiKey: 'chave-de-teste', extendedGiftInfo: false } },
  ]);
  await manager.close();
});

test('liga o catálogo de presentes somente com a variável explícita', () => {
  assert.equal(extendedGiftInfoEnabled({ TIKTOK_EXTENDED_GIFT_INFO: ' TRUE ' }), true);
  assert.equal(extendedGiftInfoEnabled({ TIKTOK_EXTENDED_GIFT_INFO: 'true' }), true);
  for (const value of ['false', '1', 'yes', 'on', '']) {
    assert.equal(extendedGiftInfoEnabled({ TIKTOK_EXTENDED_GIFT_INFO: value }), false, value);
  }
  assert.equal(extendedGiftInfoEnabled({}), false);
  assert.equal(extendedGiftInfoEnabled(null), false);
});

test('opções da conexão: catálogo premium desligado por padrão e assinatura mantida', () => {
  withEnv({ TIKTOK_EXTENDED_GIFT_INFO: undefined, SIGN_API_KEY: undefined }, () => {
    // Nada configurado: sem catálogo e sem chave (acesso compartilhado).
    assert.deepEqual(buildConnectionOptions(), {
      processInitialData: false,
      enableExtendedGiftInfo: false,
    });
    // A chave continua assinando o WebSocket.
    assert.deepEqual(buildConnectionOptions({ signApiKey: 'chave-euler' }), {
      processInitialData: false,
      enableExtendedGiftInfo: false,
      signApiKey: 'chave-euler',
    });
  });

  // Opt-in explícito (plano Business): só o booleano true liga.
  assert.equal(
    buildConnectionOptions({ signApiKey: null, extendedGiftInfo: true }).enableExtendedGiftInfo,
    true,
  );
  assert.equal(
    buildConnectionOptions({ signApiKey: null, extendedGiftInfo: 'false' }).enableExtendedGiftInfo,
    false,
  );

  // Lê a variável de ambiente quando o chamador não decide.
  withEnv({ TIKTOK_EXTENDED_GIFT_INFO: 'true', SIGN_API_KEY: ' chave-do-ambiente ' }, () => {
    const options = buildConnectionOptions();
    assert.equal(options.enableExtendedGiftInfo, true);
    assert.equal(options.signApiKey, 'chave-do-ambiente');
  });
});

test('o gerenciador encaminha a escolha do catálogo e a deixa desligada sem configuração', async () => {
  const received = [];
  const factory = (_username, options) => {
    received.push(options);
    return new FakeConnection();
  };

  for (const extendedGiftInfo of [false, true]) {
    const manager = new LiveManager({
      signApiKey: 'k',
      extendedGiftInfo,
      connectionFactory: factory,
      logger: quietLogger,
    });
    await manager.connect('criador');
    await manager.close();
  }
  assert.deepEqual(received, [
    { signApiKey: 'k', extendedGiftInfo: false },
    { signApiKey: 'k', extendedGiftInfo: true },
  ]);

  const unconfigured = withEnv({ TIKTOK_EXTENDED_GIFT_INFO: undefined }, () => (
    new LiveManager({ logger: quietLogger })
  ));
  assert.equal(unconfigured.extendedGiftInfo, false);
});

test('conector real, opções padrão: a conexão nunca toca a rota premium gift/list/', async () => {
  const { client, calls } = fakeEulerClient({
    signUrlResponse: SIGN_URL_DENIED,
    webSocketResponse: WEBSOCKET_PLAN_DENIED,
  });
  const options = withEnv({ TIKTOK_EXTENDED_GIFT_INFO: undefined }, () => (
    buildConnectionOptions({ signApiKey: null })
  ));
  const connection = new TikTokLiveConnection('criador', {
    ...options,
    fetchRoomInfoOnConnect: false, // sem rede antes da etapa observada
    eulerApiInstance: client,
  });

  // O servidor de assinatura (falso) nega o WebSocket; o que importa é por onde passou.
  await assert.rejects(connection.connect('1234567890'), PremiumFeatureError);
  assert.deepEqual(calls.signUrl, [], 'a assinatura de URL (rota premium) não pode ser chamada');
  assert.equal(calls.webSocket, 1, 'a assinatura do WebSocket continua sendo usada');
});

test('conector real, catálogo ligado: o plano sem a rota premium derruba a conexão antes do WebSocket', async () => {
  const { client, calls } = fakeEulerClient({
    signUrlResponse: SIGN_URL_DENIED,
    webSocketResponse: WEBSOCKET_PLAN_DENIED,
  });
  const connection = new TikTokLiveConnection('criador', {
    ...buildConnectionOptions({ signApiKey: null, extendedGiftInfo: true }),
    fetchRoomInfoOnConnect: false,
    eulerApiInstance: client,
  });

  let failure;
  await assert.rejects(connection.connect('1234567890'), (error) => {
    failure = error;
    return error instanceof PremiumFeatureError;
  });

  // Reproduz a falha de produção: gift/list/ assinado pela rota premium...
  assert.equal(calls.signUrl.length, 1);
  assert.equal(new URL(calls.signUrl[0]).pathname, '/webcast/gift/list/');
  // ...aborta a conexão antes de o WebSocket sequer ser pedido.
  assert.equal(calls.webSocket, 0);

  const details = connectorErrorDetails(failure);
  assert.equal(details.kind, 'plan');
  assert.match(details.hint, /TIKTOK_EXTENDED_GIFT_INFO/);
  assert.match(details.hint, /plano Business/);
});

test('classifica a recusa de plano da Euler Stream sem mandar redefinir a chave', () => {
  // Texto exato que o conector monta para a rota de assinatura de URL (403).
  const urlSigning = new PremiumFeatureError(
    'You do not have permission from the signature provider to sign this URL.',
    'Forbidden',
    JSON.stringify({ message: 'This endpoint requires a Business plan.' }),
  );
  const url = connectorErrorDetails(urlSigning);
  assert.equal(url.kind, 'plan');
  assert.match(url.hint, /gift\/list\//);
  assert.match(url.hint, /TIKTOK_EXTENDED_GIFT_INFO/);
  assert.match(url.hint, /plano Business/);
  assert.doesNotMatch(url.hint, /Defina a variável/);
  assert.deepEqual(url.codes, ['PremiumFeatureError']);
  // O texto exibido é de uma linha só e respeita o limite, apesar da caixa multilinha do conector.
  assert.doesNotMatch(url.message, /[\n\t]/);
  assert.ok(url.message.length <= 300);
  assert.match(url.message, /^\[Premium Feature\]/);

  // Rota do WebSocket (402): plano também, mas o catálogo não é o culpado.
  const webSocket = connectorErrorDetails(
    new PremiumFeatureError(
      'Your plan does not include WebSocket signing.',
      'Error fetching the signed TikTok WebSocket',
    ),
  );
  assert.equal(webSocket.kind, 'plan');
  assert.doesNotMatch(webSocket.hint, /TIKTOK_EXTENDED_GIFT_INFO/);
  assert.match(webSocket.hint, /plano/);

  // Evento `error` do conector: a falha real vem em `exception`.
  const event = connectorErrorDetails({ info: 'Error while connecting', exception: urlSigning });
  assert.equal(event.kind, 'plan');
  assert.deepEqual(event.codes, ['PremiumFeatureError']);

  // Sem a classe (só o texto da rota ou da mensagem do servidor) também é plano.
  assert.equal(
    connectorErrorDetails(
      new Error('[fetchWebcastSignatureFromEulerRoute] This endpoint requires a Business plan.'),
    ).kind,
    'plan',
  );
  assert.equal(
    connectorErrorDetails({ message: 'Sending chats requires an API key & a paid plan.' }).kind,
    'plan',
  );
});

test('classifica pelo texto completo, mesmo que o aviso exibido seja truncado', () => {
  const longMessage = `${'detalhe do servidor de assinatura '.repeat(20)}— This endpoint requires a Business plan.`;
  assert.ok(longMessage.length > 600);

  const details = connectorErrorDetails(new Error(longMessage));
  assert.equal(details.kind, 'plan');
  assert.equal(details.message.length, 300);
  assert.doesNotMatch(details.message, /Business plan/); // a evidência está além do trecho exibido
});

test('a classificação de plano não rouba as outras falhas', () => {
  // Chave ausente ou recusada continua pedindo a SIGN_API_KEY.
  const unauthorized = connectorErrorDetails(new Error('Euler Stream: unauthorized 401'));
  assert.equal(unauthorized.kind, 'signing');
  assert.match(unauthorized.hint, /Defina a variável SIGN_API_KEY/);

  // Falta de permissão na descoberta da sala (rota de fallback) segue como assinatura.
  assert.equal(
    connectorErrorDetails(
      new Error("lack of permission for you to use Euler Stream's fallback method."),
    ).kind,
    'signing',
  );

  // Limite de uso continua sendo limite de uso, mesmo que o servidor cite o plano.
  const limited = connectorErrorDetails(
    new SignatureRateLimitError(
      'Upgrade to the Business plan for higher limits.',
      'Too many connections started, try again in %s ms.',
      { headers: { 'retry-after': '30' } },
    ),
  );
  assert.equal(limited.kind, 'rate_limit');
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
