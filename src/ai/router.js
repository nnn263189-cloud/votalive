import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import express from 'express';

import { applyPending, discardPending, listPending, runAgent, runTestCommand } from './agent.js';
import { buildDecisionRequest, describeAnswer, findAnswer } from './decisions.js';
import { listFiles, readTextFile, resolveWorkspacePath } from './workspace.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

function tokenDigest(value) {
  return createHash('sha256').update(String(value ?? '').slice(0, 16_384), 'utf8').digest();
}

/** Compara o token com tempo constante. */
export function tokenMatches(supplied, expectedDigest) {
  const digest = tokenDigest(supplied);
  if (digest.length !== expectedDigest.length) return false;
  return timingSafeEqual(digest, expectedDigest);
}

/** Guarda as sessões do app de IA (histórico + mudanças pendentes). */
export class SessionStore {
  constructor({ ttlMs = SESSION_TTL_MS, max = MAX_SESSIONS } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.sessions = new Map();
  }

  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) this.sessions.delete(id);
    }
    while (this.sessions.size > this.max) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
  }

  create() {
    this.prune();
    const id = randomUUID();
    const session = { id, history: [], pending: new Map(), createdAt: Date.now(), updatedAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.updatedAt = Date.now();
    return session;
  }
}

/**
 * Rotas do app de IA. Recebe o gateway já configurado e o token de
 * administrador do painel (quando existir).
 */
export function createAiRouter({ config, gateway, adminToken = '', sessionStore = new SessionStore() }) {
  const router = express.Router();
  const adminDigest = tokenDigest(adminToken);
  const authRequired = Boolean(adminToken);

  const workspace = {
    root: config.workspaceRoot,
    testCommand: config.testCommand,
    resolveAbsolute: (relativePath) => resolveWorkspacePath(config.workspaceRoot, relativePath).absolute,
  };

  router.use(express.json({ limit: '12mb' }));

  // O app de IA escreve código: exige o mesmo token do painel.
  // O token vem só do cabeçalho: nunca na URL, nunca no log.
  router.use((request, response, next) => {
    if (!authRequired) {
      response.setHeader('X-AI-Insecure', 'true');
      return next();
    }
    if (!tokenMatches(request.get('x-admin-token'), adminDigest)) {
      return response.status(401).json({
        error: 'unauthorized',
        message: 'Informe o token de administrador para usar o app de IA.',
      });
    }
    return next();
  });

  router.get('/status', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      configured: gateway.configured,
      authRequired,
      baseUrl: config.baseUrl,
      chatModel: config.chatModel,
      imageModel: config.imageModel,
      decisionsModel: config.decisionsModel,
      workspaceRoot: config.workspaceRoot,
      testCommand: config.testCommand,
      maxAgentSteps: config.maxAgentSteps,
    });
  });

  router.get('/models', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const models = await gateway.listModels();
      response.json({ models });
    } catch (error) {
      response.status(error?.status || 502).json({ error: 'gateway_error', message: error.message });
    }
  });

  // Conversa com streaming (Server-Sent Events).
  router.post('/chat', async (request, response) => {
    const { messages, model, sessionId } = request.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return response.status(400).json({ error: 'bad_request', message: 'Envie ao menos uma mensagem.' });
    }
    if (!gateway.configured) {
      return response.status(503).json({
        error: 'not_configured',
        message: 'Defina EXPERIENTIAL_API_KEY no servidor para usar o app de IA.',
      });
    }

    const trimmed = messages
      .filter((message) => message && typeof message.content === 'string')
      .slice(-20)
      .map((message) => ({ role: message.role || 'user', content: message.content }));

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    const send = (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      let usage = null;
      for await (const chunk of gateway.chatStream({ messages: trimmed, model: model || config.chatModel })) {
        if (chunk.type === 'delta') send('delta', { text: chunk.text });
        else if (chunk.type === 'done') usage = chunk.usage ?? null;
      }
      send('done', { usage });
    } catch (error) {
      send('error', { message: error?.message || 'Falha na conversa.' });
    }
    return response.end();
  });

  // Geração de imagem.
  router.post('/image', async (request, response) => {
    const { prompt, model, size } = request.body || {};
    if (!gateway.configured) {
      return response.status(503).json({
        error: 'not_configured',
        message: 'Defina EXPERIENTIAL_API_KEY no servidor para usar o app de IA.',
      });
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return response.status(400).json({ error: 'bad_request', message: 'Escreva o prompt da imagem.' });
    }
    try {
      const result = await gateway.generateImage({
        prompt: prompt.trim(),
        model: model || config.imageModel,
        size,
      });
      const inlined = await gateway.inlineImages(result.images);
      response.json({
        images: inlined.map((image) => image.dataUrl).filter(Boolean),
        failed: inlined.filter((image) => !image.dataUrl),
        text: result.text || '',
        usage: result.usage,
        model: result.model,
        route: result.route,
        durationMs: result.durationMs,
      });
    } catch (error) {
      response.status(error?.status || 502).json({ error: 'gateway_error', message: error.message });
    }
  });

  // Perguntas tipadas no endpoint /v1/decisions.
  router.post('/decision', async (request, response) => {
    const { input, questions, name, model } = request.body || {};
    if (!gateway.configured) {
      return response.status(503).json({
        error: 'not_configured',
        message: 'Defina EXPERIENTIAL_API_KEY no servidor para usar o app de IA.',
      });
    }
    try {
      const payload = buildDecisionRequest({
        input,
        questions,
        model: model || config.decisionsModel,
      });
      const result = await gateway.decisions(payload);
      const answer = findAnswer(result.answers, name ?? payload.questions[0]?.name);
      response.json({
        model: result.model,
        answers: result.answers,
        answer: describeAnswer(answer),
        usage: result.usage,
        durationMs: result.durationMs,
      });
    } catch (error) {
      response.status(error?.status || 400).json({ error: 'decision_error', message: error.message });
    }
  });

  // Agente de código: lê, propõe mudanças e roda os testes.
  router.post('/agent', async (request, response) => {
    const { prompt, sessionId, model } = request.body || {};
    if (!gateway.configured) {
      return response.status(503).json({
        error: 'not_configured',
        message: 'Defina EXPERIENTIAL_API_KEY no servidor para usar o app de IA.',
      });
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return response.status(400).json({ error: 'bad_request', message: 'Descreva o que o agente deve fazer.' });
    }
    const session = sessionId ? sessionStore.get(sessionId) : sessionStore.create();
    if (!session) {
      return response.status(404).json({ error: 'session_not_found', message: 'Sessão expirada. Comece uma nova conversa.' });
    }
    try {
      const result = await runAgent({
        gateway,
        workspace,
        session,
        prompt,
        model: model || config.chatModel,
        maxSteps: config.maxAgentSteps,
        testCommand: config.testCommand,
      });
      response.json({
        sessionId: session.id,
        steps: result.steps,
        pending: result.pending,
        usage: result.usage,
      });
    } catch (error) {
      response.status(error?.status || 502).json({ error: 'agent_error', message: error.message });
    }
  });

  router.get('/pending', (request, response) => {
    const session = request.query.sessionId ? sessionStore.get(String(request.query.sessionId)) : null;
    response.json({ pending: session ? listPending(session) : [] });
  });

  // Aprovar e gravar as mudanças propostas.
  router.post('/apply', async (request, response) => {
    const { sessionId } = request.body || {};
    const session = sessionId ? sessionStore.get(String(sessionId)) : null;
    if (!session) {
      return response.status(404).json({ error: 'session_not_found', message: 'Sessão expirada ou nada pendente.' });
    }
    try {
      const result = await applyPending(workspace, session);
      response.json({ ...result, pending: listPending(session) });
    } catch (error) {
      response.status(error?.status || 500).json({ error: 'apply_error', message: error.message });
    }
  });

  router.post('/discard', (request, response) => {
    const { sessionId } = request.body || {};
    const session = sessionId ? sessionStore.get(String(sessionId)) : null;
    if (!session) {
      return response.status(404).json({ error: 'session_not_found', message: 'Sessão expirada ou nada pendente.' });
    }
    response.json({ discarded: discardPending(session), pending: [] });
  });

  router.post('/tests', async (request, response) => {
    try {
      const result = await runTestCommand(workspace, { command: config.testCommand, timeoutMs: config.testTimeoutMs });
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: 'test_error', message: error.message });
    }
  });

  // Navegador de arquivos do projeto.
  router.get('/files', async (request, response) => {
    try {
      const files = await listFiles(config.workspaceRoot, { subdirectory: String(request.query.path || '') });
      response.json({ files });
    } catch (error) {
      response.status(error?.status || 400).json({ error: 'workspace_error', message: error.message });
    }
  });

  router.get('/file', async (request, response) => {
    try {
      const file = await readTextFile(config.workspaceRoot, String(request.query.path || ''));
      response.json(file);
    } catch (error) {
      response.status(error?.status || 400).json({ error: 'workspace_error', message: error.message });
    }
  });

  return { router, sessionStore, workspace };
}
