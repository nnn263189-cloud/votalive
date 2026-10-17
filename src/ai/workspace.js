import path from 'node:path';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'data',
  'coverage',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  '__pycache__',
]);

const MAX_READ_BYTES = 400_000;
const MAX_LIST_ENTRIES = 600;

export class WorkspaceError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

/** Normaliza um caminho relativo vindo do modelo ou do navegador. */
export function normalizeRelativePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new WorkspaceError('Informe o caminho do arquivo.');
  if (raw.includes('\0')) throw new WorkspaceError('Caminho inválido.');
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!unified) throw new WorkspaceError('Informe o caminho do arquivo.');
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new WorkspaceError('O caminho não pode sair da pasta do projeto.');
  }
  if (segments.length === 0) throw new WorkspaceError('Informe o caminho do arquivo.');
  return segments.join('/');
}

/**
 * Resolve o caminho dentro da raiz do workspace e garante que ele não escapa
 * (nem por "..", nem por link simbólico).
 */
export function resolveWorkspacePath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, normalized);
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
    throw new WorkspaceError('O caminho não pode sair da pasta do projeto.');
  }
  return { root: absoluteRoot, relative: normalized, absolute: target };
}

async function realpathOfNearestExisting(target) {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Resolve e valida, bloqueando escapes por link simbólico. */
export async function resolveSafePath(root, relativePath) {
  const resolved = resolveWorkspacePath(root, relativePath);
  const realRoot = await realpathOfNearestExisting(resolved.root);
  const realTarget = await realpathOfNearestExisting(resolved.absolute);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new WorkspaceError('O caminho resolve para fora da pasta do projeto.');
  }
  return resolved;
}

export async function fileExists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(root, relativePath, { maxBytes = MAX_READ_BYTES } = {}) {
  const resolved = await resolveSafePath(root, relativePath);
  const info = await stat(resolved.absolute);
  if (!info.isFile()) {
    throw new WorkspaceError('O caminho não é um arquivo.');
  }
  const content = await readFile(resolved.absolute, 'utf8');
  return {
    path: resolved.relative,
    content: content.slice(0, maxBytes),
    bytes: info.size,
    truncated: content.length > maxBytes,
  };
}

/** Lista os arquivos do projeto (ignora dependências e metadados). */
export async function listFiles(root, { subdirectory = '', maxEntries = MAX_LIST_ENTRIES } = {}) {
  const resolved = subdirectory
    ? await resolveSafePath(root, subdirectory)
    : { root: path.resolve(root), relative: '.', absolute: path.resolve(root) };
  const files = [];

  async function walk(directory, prefix) {
    if (files.length >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxEntries) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push({ path: relative, kind: 'dir' });
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await stat(absolute)).size;
        } catch {
          size = 0;
        }
        files.push({ path: relative, kind: 'file', size });
      }
    }
  }

  await walk(resolved.absolute, resolved.relative === '.' ? '' : resolved.relative);
  return files;
}

export async function writeTextFile(root, relativePath, content) {
  const resolved = await resolveSafePath(root, relativePath);
  const existed = await fileExists(resolved.absolute);
  await mkdir(path.dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, content, 'utf8');
  return {
    path: resolved.relative,
    bytes: Buffer.byteLength(content, 'utf8'),
    created: !existed,
  };
}

export async function deleteFile(root, relativePath) {
  const resolved = await resolveSafePath(root, relativePath);
  const existed = await fileExists(resolved.absolute);
  if (!existed) {
    throw new WorkspaceError('O arquivo não existe.', { status: 404 });
  }
  await rm(resolved.absolute, { force: true });
  return { path: resolved.relative, deleted: true };
}
