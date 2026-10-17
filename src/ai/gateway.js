import { DECISIONS_MODEL, GATEWAY_BASE_URL } from './config.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** Erro de HTTP ou de transporte do gateway. Sempre carrega o corpo da resposta. */
export class GatewayError extends Error {
  constructor(message, { status = 0, body = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GatewayError';
    this.status = status;
    this.body = body;
  }
}

function truncate(value, max = 800) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isBase64(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function collectImages(json) {
  const images = [];
  const push = (source) => {
    if (!source || typeof source !== 'object') return;
    const url = source.image_url?.url
      ?? (typeof source.image_url === 'string' ? source.image_url : null)
      ?? (typeof source.url === 'string' ? source.url : null);
    const base64 = source.b64_json
      ?? source.image_base64
      ?? (typeof source.data === 'string' ? source.data : null);

    if (typeof url === 'string' && url.trim() !== '') {
      images.push({ kind: 'url', url: url.trim() });
      return;
    }
    if (typeof base64 === 'string' && base64.trim() !== '') {
      const mimeType = source.mime_type || source.mimeType || 'image/png';
      images.push({ kind: 'base64', base64: base64.trim(), mimeType });
    }
  };

  const message = json?.choices?.[0]?.message ?? {};
  if (Array.isArray(message.images)) message.images.forEach(push);
  if (Array.isArray(message.content)) message.content.forEach(push);
  if (Array.isArray(json?.data)) json.data.forEach(push);
  if (Array.isArray(json?.output)) json.output.forEach(push);

  return images;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function normalizeToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls
    .filter((call) => call && typeof call.function?.name === 'string')
    .map((call) => {
      let args = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      return {
        id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.function.name,
        arguments: args,
        raw: call,
      };
    });
}

/**
 * Cliente do gateway Experiential (OpenAI-compatible).
 *
 * Regras que valem para todas as rotas:
 * - uma requisição por chamada, sem retry automático e sem Idempotency-Key
 *   (um timeout pode ter deixado a chamada já cobrada);
 * - Bearer lido apenas de EXPERIENTIAL_API_KEY;
 * - timeout limitado e erros de HTTP/transporte sempre propagados.
 */
export class ExperientialGateway {
  constructor({
    apiKey,
    baseUrl = GATEWAY_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || GATEWAY_BASE_URL).trim().replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  url(pathname) {
    return `${this.baseUrl}${pathname}`;
  }

  headers(accept = 'application/json') {
    if (!this.apiKey) {
      throw new GatewayError(
        'EXPERIENTIAL_API_KEY não configurada. Defina a variável no servidor e reinicie o processo.',
      );
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: accept,
    };
  }

  async send(pathname, { method = 'POST', body, timeoutMs = this.timeoutMs, accept = 'application/json' } = {}) {
    const startedAt = Date.now();
    let response;
    try {
      response = await this.fetchImpl(this.url(pathname), {
        method,
        headers: this.headers(accept),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new GatewayError(
          `Tempo esgotado (${timeoutMs} ms) em ${pathname}. A chamada pode já ter sido cobrada; não repita automaticamente.`,
          { cause: error },
        );
      }
      throw new GatewayError(
        `Falha de transporte em ${pathname}: ${error?.message || error}`,
        { cause: error },
      );
    }

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      throw new GatewayError(
        `HTTP ${response.status} em ${pathname}: ${truncate(text || response.statusText)}`,
        { status: response.status, body: text },
      );
    }

    return { json, text, status: response.status, durationMs: Date.now() - startedAt };
  }

  /** Chat Completion simples (sem streaming). */
  async chat({ messages, model, tools, maxTokens, extra } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new GatewayError('chat exige ao menos uma mensagem.');
    }
    const payload = { model, messages };
    if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
    if (Number.isInteger(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;
    if (extra && typeof extra === 'object') Object.assign(payload, extra);

    const { json, durationMs } = await this.send('/chat/completions', { body: payload });
    const message = json?.choices?.[0]?.message ?? {};
    return {
      text: textFromContent(message.content),
      toolCalls: normalizeToolCalls(message.tool_calls),
      usage: json?.usage ?? null,
      model: json?.model ?? model,
      durationMs,
      raw: json,
    };
  }

  /**
   * Chat Completion em streaming (SSE). Gera eventos {type:'delta'|'done'}.
   */
  async *chatStream({ messages, model, tools, maxTokens } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new GatewayError('chatStream exige ao menos uma mensagem.');
    }
    const payload = { model, messages, stream: true };
    if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
    if (Number.isInteger(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;

    let response;
    try {
      response = await this.fetchImpl(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers('text/event-stream'),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new GatewayError(
          `Tempo esgotado (${this.timeoutMs} ms) no streaming. A chamada pode já ter sido cobrada.`,
          { cause: error },
        );
      }
      throw new GatewayError(`Falha de transporte no streaming: ${error?.message || error}`, { cause: error });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new GatewayError(
        `HTTP ${response.status} no streaming: ${truncate(text || response.statusText)}`,
        { status: response.status, body: text },
      );
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      throw new GatewayError('O streaming não devolveu um corpo legível.');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');

          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            yield { type: 'done', usage };
            return;
          }
          if (!data) continue;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk?.usage) usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta ?? {};
          const text = typeof delta.content === 'string' ? delta.content : '';
          if (text) yield { type: 'delta', text };
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    yield { type: 'done', usage };
  }

  /**
   * Geração de imagem. O gateway expõe modelos de imagem por dois caminhos:
   * chat/completions com `modalities` e images/generations. Tentamos o
   * primeiro e caímos para o segundo quando a rota não servir o modelo.
   */
  async generateImage({ prompt, model, size, aspectRatio } = {}) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new GatewayError('A imagem precisa de um prompt.');
    }

    const chatPayload = { model, messages: [{ role: 'user', content: prompt }], modalities: ['text', 'image'] };
    if (size) chatPayload.size = size;

    let firstError = null;
    try {
      const { json, durationMs } = await this.send('/chat/completions', { body: chatPayload });
      const images = collectImages(json);
      if (images.length > 0) {
        return {
          images,
          text: textFromContent(json?.choices?.[0]?.message?.content),
          usage: json?.usage ?? null,
          model: json?.model ?? model,
          route: 'chat/completions',
          durationMs,
        };
      }
      firstError = new GatewayError(
        `O modelo "${model}" respondeu sem imagem no chat/completions.`,
        { status: 200, body: JSON.stringify(json ?? {}).slice(0, 800) },
      );
    } catch (error) {
      firstError = error;
      if (error instanceof GatewayError && ![400, 404, 405, 422].includes(error.status)) {
        throw error;
      }
    }

    const imagePayload = { model, prompt, n: 1 };
    if (size) imagePayload.size = size;
    if (aspectRatio) imagePayload.aspect_ratio = aspectRatio;

    try {
      const { json, durationMs } = await this.send('/images/generations', { body: imagePayload });
      const images = collectImages(json);
      if (images.length === 0) {
        throw new GatewayError(
          `O modelo "${model}" não devolveu imagem nem em images/generations.`,
          { status: 200, body: JSON.stringify(json ?? {}).slice(0, 800) },
        );
      }
      return {
        images,
        text: textFromContent(json?.choices?.[0]?.message?.content),
        usage: json?.usage ?? null,
        model: json?.model ?? model,
        route: 'images/generations',
        durationMs,
      };
    } catch (error) {
      if (error instanceof GatewayError && error.status === 0) throw error;
      if (firstError) {
        throw new GatewayError(
          `Falha ao gerar imagem: ${firstError.message} | ${error.message}`,
          { status: error.status || firstError.status, body: error.body || firstError.body },
        );
      }
      throw error;
    }
  }

  /** Converte imagens remotas em data URL para o navegador (CSP do app). */
  async inlineImages(images) {
    const result = [];
    for (const image of images) {
      if (image.kind === 'base64') {
        result.push({ dataUrl: `data:${image.mimeType};base64,${image.base64}` });
        continue;
      }
      try {
        const response = await this.fetchImpl(image.url, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
        if (!response.ok) {
          result.push({ dataUrl: null, url: image.url, error: `HTTP ${response.status}` });
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_INLINE_IMAGE_BYTES) {
          result.push({ dataUrl: null, url: image.url, error: 'Imagem grande demais para embutir.' });
          continue;
        }
        const mimeType = response.headers?.get?.('content-type') || 'image/png';
        result.push({ dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` });
      } catch (error) {
        result.push({ dataUrl: null, url: image.url, error: error?.message || 'Falha ao baixar a imagem.' });
      }
    }
    return result;
  }

  /** POST /v1/decisions — perguntas tipadas (predicate, choice, score). */
  async decisions({ input, questions, model = DECISIONS_MODEL } = {}) {
    const payload = { model, input, questions };
    const { json, durationMs } = await this.send('/decisions', { body: payload });
    return {
      model: json?.model ?? model,
      answers: Array.isArray(json?.answers) ? json.answers : [],
      usage: json?.usage ?? null,
      durationMs,
      raw: json,
    };
  }

  /** GET /v1/models — slugs que a chave pode chamar. */
  async listModels() {
    const { json } = await this.send('/models', { method: 'GET' });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
      .filter((id) => typeof id === 'string' && id.trim() !== '');
  }
}

export { collectImages, isBase64, normalizeToolCalls, textFromContent };
