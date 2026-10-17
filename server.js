import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { getSimulationGift, parseGiftEvent } from './src/gifts.js';
import {
  applyEulerFallbackSetting,
  eulerFallbackDisabled,
  extendedGiftInfoEnabled,
  LiveManager,
  resolveSignApiKey,
} from './src/live-manager.js';
import { readAiConfig } from './src/ai/config.js';
import { ExperientialGateway } from './src/ai/gateway.js';
import { createAiRouter } from './src/ai/router.js';
import { loadState, StatePersistence } from './src/persistence.js';
import { VoteStore } from './src/state-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requestedPort = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535
  ? requestedPort
  : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_RAILWAY = Boolean(
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_ENVIRONMENT_NAME ||
  process.env.RAILWAY_PUBLIC_DOMAIN,
);
const ALLOW_INSECURE_CONTROL = process.env.ALLOW_INSECURE_CONTROL === 'true';
const STATE_FILE = process.env.STATE_FILE === 'off'
  ? null
  : path.resolve(__dirname, process.env.STATE_FILE || 'data/state.json');
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const ADMIN_TOKEN_DIGEST = createHash('sha256').update(ADMIN_TOKEN, 'utf8').digest();
const SIGN_API_KEY = resolveSignApiKey();
const EULER_FALLBACK_DISABLED = applyEulerFallbackSetting();
const EXTENDED_GIFT_INFO = extendedGiftInfoEnabled();
const AI_CONFIG = readAiConfig();
const AI_GATEWAY = new ExperientialGateway({
  apiKey: AI_CONFIG.apiKey,
  baseUrl: AI_CONFIG.baseUrl,
  timeoutMs: AI_CONFIG.timeoutMs,
});

if ((IS_PRODUCTION || IS_RAILWAY) && !ADMIN_TOKEN && !ALLOW_INSECURE_CONTROL) {
  throw new Error(
    'ADMIN_TOKEN é obrigatório em produção e no Railway. Configure a variável ou, por sua conta e risco, ALLOW_INSECURE_CONTROL=true.',
  );
}
if (!ADMIN_TOKEN) {
  console.warn('[Segurança] ADMIN_TOKEN não definido: os controles do painel estão desbloqueados.');
} else if (ADMIN_TOKEN.length < 16) {
  console.warn('[Segurança] Use um ADMIN_TOKEN com pelo menos 16 caracteres aleatórios.');
}
if (!SIGN_API_KEY) {
  console.warn(
    '[TikTok] SIGN_API_KEY não definida: a assinatura usa o acesso compartilhado da Euler Stream e o TikTok pode recusar a conexão. Configure a chave no serviço e reinicie o deploy.',
  );
}
if (EULER_FALLBACK_DISABLED) {
  console.warn(
    '[TikTok] TIKTOK_SKIP_EULER_FALLBACK=true: a rota de fallback da Euler Stream para descobrir a sala está desativada.',
  );
}
if (EXTENDED_GIFT_INFO) {
  console.warn(
    '[TikTok] TIKTOK_EXTENDED_GIFT_INFO=true: a conexão baixa o catálogo de presentes pela rota premium gift/list/ da Euler Stream (plano Business). Sem o plano a conexão falha com PremiumFeatureError; remova a variável para desativar.',
  );
}
if (!AI_CONFIG.apiKey) {
  console.warn(
    '[IA] EXPERIENTIAL_API_KEY não definida: o app de IA (/ai) fica desativado. Configure a chave no serviço e reinicie.',
  );
}

const persistence = new StatePersistence(STATE_FILE);
const savedState = await loadState(STATE_FILE);
const store = new VoteStore({
  savedState,
  onChange: (state) => persistence.schedule(state),
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'self'; frame-ancestors 'self'",
  );
  next();
});

let connectionStatus = {
  phase: 'idle',
  username: null,
  roomId: null,
  message: null,
  kind: null,
  hint: null,
  codes: [],
  attempt: 0,
};

function publicPayload(type, extra = {}) {
  return {
    type,
    ...extra,
    connection: { ...connectionStatus },
    state: store.snapshot(),
  };
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function publish(type, extra = {}) {
  broadcast(publicPayload(type, extra));
}

const liveManager = new LiveManager({
  signApiKey: SIGN_API_KEY,
  extendedGiftInfo: EXTENDED_GIFT_INFO,
  onStatus: (status) => {
    connectionStatus = status;
    publish('status');
  },
  onConnected: ({ username, roomId }) => {
    const newSession = store.startLiveSession({ username, roomId });
    if (newSession) publish('session_started');
  },
  onGift: (rawGift) => {
    const parsed = parseGiftEvent(rawGift);
    if (parsed.status === 'pending') return;

    const result = store.recordGift(parsed.gift);
    if (result.duplicate) {
      console.warn(`[Gift duplicado] Evento ${parsed.gift.eventId || '?'} ignorado.`);
      return;
    }

    const activity = result.activity;
    const who = activity.username || activity.nickname || '?';
    if (!activity.recognized) {
      console.log(
        `[Gift não mapeado] @${who} → ${activity.giftName} x${activity.repeatCount} (${activity.diamondCount}♦ cada)`,
      );
      publish('gift_ignored', { gift: activity });
      return;
    }

    console.log(
      `[Gift] @${who} → ${activity.giftName} x${activity.repeatCount} = +${activity.points} pts → Candidato ${activity.candidateId}`,
    );
    publish('gift', { gift: activity });
  },
  onStreamEnd: () => {
    store.markSessionEnded();
    publish('stream_ended');
  },
  onConnectorError: ({ message, kind, hint, codes }) => {
    publish('connector_warning', { message, kind, hint, codes });
  },
});

app.get('/healthz', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({
    ok: true,
    connection: connectionStatus.phase,
    username: connectionStatus.username,
    message: connectionStatus.message,
    kind: connectionStatus.kind,
    hint: connectionStatus.hint,
    codes: connectionStatus.codes,
    signing: Boolean(SIGN_API_KEY),
    eulerFallbackDisabled: EULER_FALLBACK_DISABLED,
    extendedGiftInfo: EXTENDED_GIFT_INFO,
    sessionId: store.snapshot().session?.id || null,
  });
});

app.get('/api/state', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json(publicPayload('snapshot', {
    authRequired: Boolean(ADMIN_TOKEN),
  }));
});

// App de IA: conversar, gerar imagens e mexer no código com aprovação humana.
const ai = createAiRouter({
  config: AI_CONFIG,
  gateway: AI_GATEWAY,
  adminToken: ADMIN_TOKEN,
});
app.use('/api/ai', ai.router);

app.get('/ai', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(__dirname, 'public', 'ai.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: IS_PRODUCTION ? '1h' : 0,
  setHeaders(response, filePath) {
    if (filePath.endsWith('.html')) response.setHeader('Cache-Control', 'no-store');
  },
}));

function requestOriginIsAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHost = forwardedHost || request.headers.host;
    return originUrl.host === requestHost;
  } catch {
    return false;
  }
}

function tokenMatches(candidate) {
  const suppliedDigest = createHash('sha256')
    .update(String(candidate || '').slice(0, 16_384), 'utf8')
    .digest();
  return timingSafeEqual(suppliedDigest, ADMIN_TOKEN_DIGEST);
}

function commandAllowed(socket) {
  const now = Date.now();
  socket.commandTimes = socket.commandTimes.filter((timestamp) => now - timestamp < 60_000);
  if (socket.commandTimes.length >= 90) return false;
  socket.commandTimes.push(now);
  return true;
}

wss.on('connection', (socket, request) => {
  if (!requestOriginIsAllowed(request)) {
    socket.close(1008, 'Origem não permitida');
    return;
  }

  socket.isAlive = true;
  socket.authorized = !ADMIN_TOKEN;
  socket.failedAuthAttempts = 0;
  socket.commandTimes = [];
  socket.on('pong', () => { socket.isAlive = true; });

  send(socket, publicPayload('hello', {
    authRequired: Boolean(ADMIN_TOKEN),
    authorized: socket.authorized,
    insecureControl: !ADMIN_TOKEN,
  }));

  socket.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(socket, { type: 'command_error', message: 'Mensagem inválida.' });
      return;
    }

    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'auth') {
      if (!ADMIN_TOKEN || tokenMatches(message.token)) {
        socket.authorized = true;
        socket.failedAuthAttempts = 0;
        send(socket, { type: 'auth_result', ok: true });
      } else {
        socket.failedAuthAttempts += 1;
        send(socket, {
          type: 'auth_result',
          ok: false,
          message: 'Token de controle incorreto.',
        });
        if (socket.failedAuthAttempts >= 5) socket.close(1008, 'Muitas tentativas de autenticação');
      }
      return;
    }

    const controlCommands = new Set(['connect', 'disconnect', 'reset', 'simulate']);
    if (!controlCommands.has(message.type)) return;

    if (!socket.authorized) {
      send(socket, {
        type: 'command_error',
        code: 'unauthorized',
        message: 'Desbloqueie os controles com o token de administrador.',
      });
      return;
    }
    if (!commandAllowed(socket)) {
      send(socket, {
        type: 'command_error',
        code: 'rate_limited',
        message: 'Muitos comandos. Aguarde um minuto e tente novamente.',
      });
      return;
    }

    try {
      if (message.type === 'connect') {
        await liveManager.connect(message.username);
      } else if (message.type === 'disconnect') {
        await liveManager.disconnect();
      } else if (message.type === 'reset') {
        store.reset();
        publish('reset');
      } else if (message.type === 'simulate') {
        const rule = getSimulationGift(message.giftKey);
        if (!rule) throw new Error('Presente de teste não configurado.');
        store.ensureDemoSession();
        const result = store.recordGift({
          eventId: `simulation:${randomUUID()}`,
          giftName: rule.label,
          emoji: rule.emoji,
          pointsPerUnit: rule.votes,
          candidateId: rule.candidateId,
          repeatCount: 1,
          diamondCount: 0,
          username: 'teste',
          nickname: 'Modo de teste',
          source: 'simulation',
        });
        publish('gift', { gift: result.activity });
      }
    } catch (error) {
      const messageText = String(error?.message || error || 'Falha no comando').slice(0, 300);
      send(socket, { type: 'command_error', message: messageText });
    }
  });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`\n  VotaLive disponível em http://${HOST}:${boundPort}`);
  console.log(`  Estado: ${STATE_FILE || 'somente em memória'}`);
  console.log(`  Controles: ${ADMIN_TOKEN ? 'protegidos por token' : 'desbloqueados'}`);
  console.log(`  Assinatura TikTok: ${SIGN_API_KEY ? 'SIGN_API_KEY configurada' : 'sem SIGN_API_KEY'}`);
  console.log(
    `  Catálogo de presentes: ${EXTENDED_GIFT_INFO ? 'ativo (rota premium)' : 'desativado (padrão)'}`,
  );
  console.log(
    `  App de IA: ${AI_CONFIG.apiKey ? 'pronto' : 'sem EXPERIENTIAL_API_KEY'} em http://${HOST}:${boundPort}/ai\n`,
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Servidor] Encerrando (${signal})…`);
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'Servidor encerrando');
  await liveManager.close();
  await persistence.flush();
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
