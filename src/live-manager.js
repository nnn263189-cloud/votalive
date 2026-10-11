import {
  ControlEvent,
  ErrorReason,
  RoomIdRouteConfig,
  TikTokLiveConnection,
  WebcastEvent,
} from 'tiktok-live-connector';

export function normalizeUsername(value) {
  const username = String(value ?? '').trim().replace(/^@/, '');
  if (!username) throw new Error('Informe o @username da LIVE.');
  if (!/^[a-zA-Z0-9._]{1,32}$/.test(username)) {
    throw new Error('Username inválido. Use apenas letras, números, ponto e sublinhado.');
  }
  return username;
}

/**
 * Reads the Euler Stream API key. The connector signs every WebSocket
 * handshake through this service, so a missing key means shared, rate-limited
 * access that TikTok frequently refuses.
 */
export function resolveSignApiKey(env = process.env) {
  const key = String(env?.SIGN_API_KEY ?? '').trim();
  return key || null;
}

export function eulerFallbackDisabled(env = process.env) {
  return String(env?.TIKTOK_SKIP_EULER_FALLBACK ?? '').trim().toLowerCase() === 'true';
}

/**
 * Opt-in escape hatch documented by the connector: when the room id cannot be
 * resolved, it falls back to Euler Stream and that route needs permission. The
 * caller can disable the fallback instead of granting it.
 */
export function applyEulerFallbackSetting({
  enabled = eulerFallbackDisabled(),
  routeConfig = RoomIdRouteConfig,
} = {}) {
  routeConfig.skipFetchRoomIdFromEulerRoute = Boolean(enabled);
  return routeConfig.skipFetchRoomIdFromEulerRoute;
}

/**
 * Opt-in for the connector's `enableExtendedGiftInfo`. When on, `connect()`
 * downloads the room gift list from TikTok's `gift/list/`, and that request is
 * signed through Euler Stream's URL-signing route, a premium route (Business
 * plan). Without the plan the sign server answers 403, the connector throws
 * `PremiumFeatureError` and the whole connection is aborted before the
 * WebSocket is even requested.
 *
 * VotaLive does not need the catalog: id, name, type and diamond count already
 * arrive inside every gift message (`gift.*`), and `parseGiftEvent` only uses
 * `extendedGiftInfo` as optional enrichment. Only the literal "true" enables it.
 */
export function extendedGiftInfoEnabled(env = process.env) {
  return String(env?.TIKTOK_EXTENDED_GIFT_INFO ?? '').trim().toLowerCase() === 'true';
}

/**
 * Options handed to `TikTokLiveConnection`. The Euler key keeps signing the
 * WebSocket handshake; the premium gift catalog stays off unless requested.
 */
export function buildConnectionOptions({
  signApiKey = resolveSignApiKey(),
  extendedGiftInfo = extendedGiftInfoEnabled(),
} = {}) {
  const options = {
    processInitialData: false,
    enableExtendedGiftInfo: extendedGiftInfo === true,
  };
  if (signApiKey) options.signApiKey = signApiKey;
  return options;
}

function errorTexts(error) {
  const candidates = [
    error?.exception?.message,
    error?.info,
    error?.message,
    error?.code,
    error?.name,
    typeof error === 'string' ? error : '',
  ];
  return candidates.filter((item) => typeof item === 'string' && item.trim());
}

/** Untouched message of the error, used for classification. */
function rawErrorMessage(error) {
  const candidates = [
    error?.exception?.message,
    error?.info,
    error?.message,
    typeof error === 'string' ? error : '',
  ];
  return candidates.find((item) => typeof item === 'string' && item.trim()) ?? '';
}

/**
 * Short, single-line text for the panel and /healthz. The connector's sign
 * errors are multi-line boxes ("SIGN SERVER MESSAGE"); whitespace is collapsed
 * so the JSON stays readable.
 */
export function connectorErrorMessage(error) {
  const message = rawErrorMessage(error).replace(/\s+/g, ' ').trim();
  return (message || 'Falha desconhecida ao conectar ao TikTok.').slice(0, 300);
}

/**
 * The connector aggregates the per-source failures of a composite route inside
 * `config.requestErrs` (for example `InvalidResponseCompositeError` on
 * "Failed to retrieve Room ID from all sources."). The actionable cause lives
 * there, not in the outer message, so it must be inspected explicitly.
 */
function nestedErrors(error) {
  const nested = error?.config?.requestErrs ?? error?.config?.errors ?? error?.errors;
  return Array.isArray(nested) ? nested.filter((item) => item && typeof item === 'object') : [];
}

/**
 * The error plus what it wraps: the connector's `error` event delivers the real
 * failure as `{ info, exception }`, and composite routes list their causes.
 * Used for structured signals (class, `reason`, `code`), never for free text.
 */
function errorChain(error) {
  return [error, error?.exception, ...nestedErrors(error)].filter(
    (item) => item && typeof item === 'object',
  );
}

const GENERIC_ERROR_NAMES = new Set(['Error', 'Object', 'TypeError', 'RangeError', 'EventEmitter']);

/** Short, non-sensitive identifiers of the underlying failures (codes/classes). */
export function connectorErrorCodes(error) {
  const codes = [];
  for (const item of errorChain(error)) {
    const candidate = [item?.code, item?.name, item?.constructor?.name].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    const code = candidate?.trim().slice(0, 40);
    if (code && !codes.includes(code)) codes.push(code);
  }
  const specific = codes.filter((code) => !GENERIC_ERROR_NAMES.has(code));
  return (specific.length ? specific : codes).slice(0, 5);
}

// Checked in order: the signing failure is listed first because it names a
// concrete fix (SIGN_API_KEY); the aggregated text often also carries a
// secondary network error, which would otherwise mask the actionable cause.
const ERROR_HINTS = [
  {
    kind: 'signing',
    pattern: /euler|sign ?api|signature|api key|\b40[123]\b|premium feature|missing token/i,
    hint:
      'A assinatura da conexão usa a Euler Stream. Defina a variável SIGN_API_KEY no serviço (Railway → Variables), reinicie o deploy e tente conectar novamente.',
  },
  {
    kind: 'rate_limit',
    pattern: /rate limit|too many requests|\b429\b/i,
    hint:
      'A Euler Stream recusou por limite de uso. Aguarde alguns minutos ou use uma SIGN_API_KEY com cota maior.',
  },
  {
    kind: 'offline',
    pattern: /isn'?t online|is not online|offline|not live|user ?offline/i,
    hint:
      'O criador não estava ao vivo no momento da conexão. Inicie a LIVE e conecte novamente.',
  },
  {
    kind: 'network',
    pattern: /econnrefused|econnreset|econnaborted|epipe|enotfound|eai_again|etimedout|socket hang up|network|timeout/i,
    hint:
      'O servidor não alcançou os serviços do TikTok/Euler Stream. Verifique a saída de rede da hospedagem e tente de novo.',
  },
];

const ROOM_ID_HINT =
  'A sala da LIVE não pôde ser descoberta: confirme que o @ está correto e que o criador está transmitindo agora. Se persistir, configure a SIGN_API_KEY e tente de novo.';

// Plan errors: the Euler sign server answered, but the plan behind the key does
// not include the route (connector class `PremiumFeatureError`, reason
// "Premium Feature"). The cure is not "define SIGN_API_KEY" (the signing
// hint), so this kind is checked before the generic signing patterns.
const PLAN_ERROR_PATTERN =
  /\[premium feature\]|requires? (?:an? )?(?:business|paid|premium|enterprise)\b|business plan|paid plan|permission from the signature provider/i;

// The URL-signing route (`fetchWebcastSignatureFromEulerRoute`) is only used by
// this app to download the gift catalog (`gift/list/`), which is opt-in.
const URL_SIGNING_PATTERN = /sign this url|fetchWebcastSignatureFromEulerRoute/i;

const PLAN_HINT_GIFT_CATALOG =
  'A Euler Stream negou a assinatura de URL do catálogo de presentes (gift/list/): essa rota premium exige o plano Business. O catálogo é opcional — remova TIKTOK_EXTENDED_GIFT_INFO do serviço (Railway → Variables), reinicie o deploy e conecte de novo — ou use uma chave de plano Business.';

const PLAN_HINT =
  'A Euler Stream negou esta rota por limite de plano (recurso premium). Confira o plano e a cota em eulerstream.com; trocar a chave por outra do mesmo plano não resolve.';

function isPlanError(chain, haystack) {
  // A rate limit is its own kind even when the server text pitches a plan.
  if (chain.some((item) => item.reason === ErrorReason.RATE_LIMIT)) return false;
  if (chain.some((item) => item.reason === ErrorReason.PREMIUM_FEATURE)) return true;
  return PLAN_ERROR_PATTERN.test(haystack);
}

/**
 * Classifies the connector error so the panel and /healthz can show what to do
 * next instead of only the raw message. The aggregated causes are inspected
 * because composite routes only report "from all sources" on the outside, and
 * the whole text (not the truncated message shown to the user) is searched.
 */
export function connectorErrorDetails(error) {
  const message = connectorErrorMessage(error);
  const haystack = [
    rawErrorMessage(error).replace(/\s+/g, ' ').trim(),
    ...nestedErrors(error).flatMap((item) => errorTexts(item)),
  ]
    .join(' | ')
    .slice(0, 2_000);
  const codes = connectorErrorCodes(error);

  if (isPlanError(errorChain(error), haystack)) {
    const hint = URL_SIGNING_PATTERN.test(haystack) ? PLAN_HINT_GIFT_CATALOG : PLAN_HINT;
    return { message, kind: 'plan', hint, codes };
  }
  for (const entry of ERROR_HINTS) {
    if (entry.pattern.test(haystack)) return { message, kind: entry.kind, hint: entry.hint, codes };
  }
  if (/room id from all sources/i.test(message)) {
    return { message, kind: 'room_id', hint: ROOM_ID_HINT, codes };
  }
  return { message, kind: 'unknown', hint: null, codes };
}

function defaultConnectionFactory(username, { signApiKey, extendedGiftInfo } = {}) {
  return new TikTokLiveConnection(username, buildConnectionOptions({ signApiKey, extendedGiftInfo }));
}

export class LiveManager {
  constructor({
    connectionFactory = defaultConnectionFactory,
    signApiKey = resolveSignApiKey(),
    extendedGiftInfo = extendedGiftInfoEnabled(),
    onStatus = () => {},
    onConnected = () => {},
    onGift = () => {},
    onStreamEnd = () => {},
    onConnectorError = () => {},
    logger = console,
    reconnectDelays = [2_000, 5_000, 10_000, 20_000, 30_000],
  } = {}) {
    this.connectionFactory = connectionFactory;
    this.signApiKey = signApiKey;
    this.extendedGiftInfo = extendedGiftInfo === true;
    this.onStatus = onStatus;
    this.onConnected = onConnected;
    this.onGift = onGift;
    this.onStreamEnd = onStreamEnd;
    this.onConnectorError = onConnectorError;
    this.logger = logger;
    this.reconnectDelays = reconnectDelays;

    this.connection = null;
    this.username = null;
    this.shouldReconnect = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.intentId = 0;
    this.status = {
      phase: 'idle',
      username: null,
      roomId: null,
      message: null,
      kind: null,
      hint: null,
      codes: [],
      attempt: 0,
    };
  }

  getStatus() {
    return { ...this.status };
  }

  setStatus(phase, details = {}) {
    this.status = {
      phase,
      username: details.username ?? this.username ?? null,
      roomId: details.roomId ?? null,
      message: details.message ?? null,
      kind: details.kind ?? null,
      hint: details.hint ?? null,
      codes: Array.isArray(details.codes) ? details.codes : [],
      attempt: details.attempt ?? 0,
    };
    this.onStatus(this.getStatus());
  }

  async connect(value) {
    const username = normalizeUsername(value);
    if (
      this.status.phase === 'connected' &&
      this.username?.toLowerCase() === username.toLowerCase()
    ) {
      return this.getStatus();
    }

    const intentId = ++this.intentId;
    this.username = username;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    await this.disposeActiveConnection();

    if (intentId !== this.intentId) return this.getStatus();
    this.setStatus('connecting', { username });
    return this.startAttempt(intentId, false);
  }

  async disconnect() {
    ++this.intentId;
    this.shouldReconnect = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    await this.disposeActiveConnection();
    this.username = null;
    this.setStatus('idle', { username: null, roomId: null });
  }

  async close() {
    ++this.intentId;
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    await this.disposeActiveConnection();
  }

  async startAttempt(intentId, isReconnect) {
    if (intentId !== this.intentId || !this.shouldReconnect || !this.username) {
      return this.getStatus();
    }

    const username = this.username;
    const connection = this.connectionFactory(username, {
      signApiKey: this.signApiKey,
      extendedGiftInfo: this.extendedGiftInfo,
    });
    this.connection = connection;
    let connected = false;

    const handleConnected = (state = {}) => {
      if (connected || this.connection !== connection || intentId !== this.intentId) return;
      connected = true;
      this.reconnectAttempt = 0;
      const roomId = String(state.roomId ?? connection.roomId ?? '');
      this.onConnected({ username, roomId, state });
      this.setStatus('connected', { username, roomId });
      this.logger.log(`[TikTok] Conectado em @${username} (sala ${roomId || '?'})`);
    };

    connection.on(ControlEvent.CONNECTED, handleConnected);
    connection.on(ControlEvent.DISCONNECTED, ({ code, reason } = {}) => {
      if (this.connection !== connection || intentId !== this.intentId) return;
      this.connection = null;
      this.logger.warn(
        `[TikTok] Conexão com @${username} encerrada (${code ?? '?'}${reason ? `: ${reason}` : ''})`,
      );
      if (this.shouldReconnect) this.scheduleReconnect(intentId);
    });
    connection.on(ControlEvent.ERROR, (error) => {
      if (this.connection !== connection || intentId !== this.intentId) return;
      const details = connectorErrorDetails(error);
      this.logger.error(`[TikTok] ${details.message}`);
      if (details.hint) this.logger.warn(`[TikTok] ${details.hint}`);
      this.onConnectorError({ ...details, error });
    });
    connection.on(WebcastEvent.GIFT, (data) => {
      if (this.connection !== connection || intentId !== this.intentId) return;
      try {
        this.onGift(data);
      } catch (error) {
        const details = connectorErrorDetails(error);
        this.logger.error('[TikTok] Falha ao processar presente:', details.message);
        this.onConnectorError({ ...details, error });
      }
    });
    connection.on(WebcastEvent.STREAM_END, () => {
      if (this.connection !== connection || intentId !== this.intentId) return;
      this.shouldReconnect = false;
      this.clearReconnectTimer();
      this.connection = null;
      this.onStreamEnd({ username, roomId: this.status.roomId });
      this.setStatus('ended', {
        username,
        roomId: this.status.roomId,
        message: 'A LIVE terminou. O placar foi preservado.',
      });
      void this.safeDisconnect(connection);
    });

    try {
      const state = await connection.connect();
      if (this.connection !== connection || intentId !== this.intentId) {
        await this.safeDisconnect(connection);
        return this.getStatus();
      }
      handleConnected(state);
      return this.getStatus();
    } catch (error) {
      if (this.connection !== connection || intentId !== this.intentId) {
        await this.safeDisconnect(connection);
        return this.getStatus();
      }

      this.connection = null;
      await this.safeDisconnect(connection);
      const details = connectorErrorDetails(error);
      this.logger.error(`[TikTok] Não conectou em @${username}: ${details.message}`);
      if (details.hint) this.logger.warn(`[TikTok] ${details.hint}`);
      this.onConnectorError({ ...details, error });

      if (isReconnect && this.shouldReconnect) {
        this.scheduleReconnect(intentId, details);
      } else {
        this.shouldReconnect = false;
        this.setStatus('error', { username, ...details });
      }
      return this.getStatus();
    }
  }

  scheduleReconnect(intentId, lastError = null) {
    if (intentId !== this.intentId || !this.shouldReconnect || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1);
    const delay = this.reconnectDelays[index];
    this.reconnectAttempt += 1;
    const last = typeof lastError === 'string' ? { message: lastError } : lastError || {};
    this.setStatus('reconnecting', {
      username: this.username,
      message: last.message ?? null,
      kind: last.kind ?? null,
      hint: last.hint ?? null,
      codes: last.codes ?? [],
      attempt: this.reconnectAttempt,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startAttempt(intentId, true);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async disposeActiveConnection() {
    const connection = this.connection;
    this.connection = null;
    if (connection) await this.safeDisconnect(connection);
  }

  async safeDisconnect(connection) {
    try {
      connection.removeAllListeners?.();
      await connection.disconnect();
    } catch {
      // Disconnect is best-effort; the next connection uses a new instance.
    }
  }
}
