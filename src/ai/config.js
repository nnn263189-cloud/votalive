import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..', '..');

/** Gateway OpenAI-compatible da Experiential Labs. */
export const GATEWAY_BASE_URL = 'https://api.experientiallabs.ai/v1';

/** Modelo de decisão: o endpoint /v1/decisions só serve este slug. */
export const DECISIONS_MODEL = 'gpt-6-luna-decisions';

export const DEFAULT_CHAT_MODEL = 'gpt-6-luna';
export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Lê a configuração do app de IA do ambiente.
 *
 * A chave do gateway vem SOMENTE de EXPERIENTIAL_API_KEY. Nunca de outro
 * lugar, nunca de um parâmetro de requisição e nunca do navegador.
 */
export function readAiConfig(env = process.env) {
  const apiKey = String(env.EXPERIENTIAL_API_KEY || '').trim();
  const workspaceRaw = String(env.AI_WORKSPACE_ROOT || '').trim();

  return {
    apiKey,
    baseUrl: String(env.AI_BASE_URL || GATEWAY_BASE_URL).trim().replace(/\/+$/, ''),
    chatModel: String(env.AI_CHAT_MODEL || DEFAULT_CHAT_MODEL).trim(),
    imageModel: String(env.AI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim(),
    decisionsModel: DECISIONS_MODEL,
    workspaceRoot: workspaceRaw
      ? path.resolve(projectRoot, workspaceRaw)
      : projectRoot,
    testCommand: String(env.AI_TEST_COMMAND || 'npm test').trim(),
    timeoutMs: positiveInt(env.AI_TIMEOUT_MS, 120_000),
    maxAgentSteps: positiveInt(env.AI_MAX_AGENT_STEPS, 12),
    testTimeoutMs: positiveInt(env.AI_TEST_TIMEOUT_MS, 180_000),
  };
}
