import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Carrega pares de um arquivo .env simples (sem dependência).
 * Não sobrescreve variáveis já presentes no ambiente: quem manda é o
 * ambiente real (Railway, Docker, CI) e o .env só preenche o que falta.
 */
export async function loadEnvFile(filePath, env = process.env) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return { env, loaded: 0 };
  }

  let loaded = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key || key in env) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
    loaded += 1;
  }
  return { env, loaded };
}

/** Caminho do .env na raiz do projeto. */
export function projectEnvPath() {
  return path.resolve(here, '..', '.env');
}
