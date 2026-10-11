import { ControlEvent, TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';

export function normalizeUsername(value) {
  const username = String(value ?? '').trim().replace(/^@/, '');
  if (!username) throw new Error('Informe o @username da LIVE.');
  if (!/^[a-zA-Z0-9._]{1,32}$/.test(username)) {
    throw new Error('Username inválido. Use apenas letras, números, ponto e sublinhado.');
  }
  return username;
}

export function connectorErrorMessage(error) {
  const candidates = [
    error?.exception?.message,
    error?.info,
    error?.message,
    typeof error === 'string' ? error : '',
  ];
  const message = candidates.find((item) => typeof item === 'string' && item.trim());
  return (message || 'Falha desconhecida ao conectar ao TikTok.').trim().slice(0, 300);
}

function defaultConnectionFactory(username) {
  return new TikTokLiveConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true,
  });
}

export class LiveManager {
  constructor({
    connectionFactory = defaultConnectionFactory,
    onStatus = () => {},
    onConnected = () => {},
    onGift = () => {},
    onStreamEnd = () => {},
    onConnectorError = () => {},
    logger = console,
    reconnectDelays = [2_000, 5_000, 10_000, 20_000, 30_000],
  } = {}) {
    this.connectionFactory = connectionFactory;
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
    const connection = this.connectionFactory(username);
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
      const message = connectorErrorMessage(error);
      this.logger.error(`[TikTok] ${message}`);
      this.onConnectorError({ message, error });
    });
    connection.on(WebcastEvent.GIFT, (data) => {
      if (this.connection !== connection || intentId !== this.intentId) return;
      try {
        this.onGift(data);
      } catch (error) {
        const message = connectorErrorMessage(error);
        this.logger.error('[TikTok] Falha ao processar presente:', message);
        this.onConnectorError({ message, error });
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
      const message = connectorErrorMessage(error);
      this.logger.error(`[TikTok] Não conectou em @${username}: ${message}`);
      this.onConnectorError({ message, error });

      if (isReconnect && this.shouldReconnect) {
        this.scheduleReconnect(intentId, message);
      } else {
        this.shouldReconnect = false;
        this.setStatus('error', { username, message });
      }
      return this.getStatus();
    }
  }

  scheduleReconnect(intentId, lastMessage = null) {
    if (intentId !== this.intentId || !this.shouldReconnect || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1);
    const delay = this.reconnectDelays[index];
    this.reconnectAttempt += 1;
    this.setStatus('reconnecting', {
      username: this.username,
      message: lastMessage,
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
