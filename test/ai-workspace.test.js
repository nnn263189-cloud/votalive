import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diffLines, formatUnifiedDiff, summarizeDiff } from '../src/ai/diff.js';
import {
  deleteFile,
  listFiles,
  normalizeRelativePath,
  readTextFile,
  resolveSafePath,
  writeTextFile,
} from '../src/ai/workspace.js';

async function temporaryProject() {
  const directory = await mkdtemp(path.join(tmpdir(), 'votalive-ai-'));
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await writeFile(path.join(directory, 'src', 'app.js'), 'export const ok = true;\n', 'utf8');
  await writeFile(path.join(directory, 'README.md'), '# projeto\n', 'utf8');
  return directory;
}

test('caminhos com .. ou absolutos são recusados', async () => {
  const root = await temporaryProject();
  try {
    assert.throws(() => normalizeRelativePath('../fora.js'), /não pode sair/);
    assert.throws(() => normalizeRelativePath('src/../../fora.js'), /não pode sair/);
    assert.throws(() => normalizeRelativePath(''), /Informe o caminho/);
    await assert.rejects(() => resolveSafePath(root, '../fora.js'), /não pode sair/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('link simbólico para fora do projeto é bloqueado', async () => {
  const root = await temporaryProject();
  const outside = await mkdtemp(path.join(tmpdir(), 'votalive-fora-'));
  try {
    await writeFile(path.join(outside, 'segredo.txt'), 'não deve vazar\n', 'utf8');
    await symlink(outside, path.join(root, 'atalho'), 'dir');
    await assert.rejects(() => resolveSafePath(root, 'atalho/segredo.txt'), /fora da pasta do projeto/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('lê, escreve e remove arquivos dentro do projeto', async () => {
  const root = await temporaryProject();
  try {
    const file = await readTextFile(root, 'src/app.js');
    assert.match(file.content, /export const ok/);

    await writeTextFile(root, 'src/novo.js', 'export const novo = 1;\n');
    assert.equal(await readFile(path.join(root, 'src', 'novo.js'), 'utf8'), 'export const novo = 1;\n');

    await deleteFile(root, 'src/novo.js');
    await assert.rejects(() => readTextFile(root, 'src/novo.js'), /não existe|ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a listagem ignora dependências e metadados', async () => {
  const root = await temporaryProject();
  try {
    await mkdir(path.join(root, 'node_modules', 'pacote'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pacote', 'index.js'), 'x', 'utf8');
    await mkdir(path.join(root, '.git'), { recursive: true });

    const files = await listFiles(root);
    const paths = files.filter((file) => file.kind === 'file').map((file) => file.path);
    assert.ok(paths.includes('src/app.js'));
    assert.ok(paths.includes('README.md'));
    assert.equal(paths.some((item) => item.includes('node_modules')), false);
    assert.equal(paths.some((item) => item.includes('.git')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('o diff aponta linhas trocadas e calcula o resumo', () => {
  const before = 'um\ndois\ntrês\n';
  const after = 'um\nDOIS\ntrês\nquatro\n';
  const operations = diffLines(before, after);
  assert.equal(operations.filter((operation) => operation.type === 'remove').length, 1);
  assert.equal(operations.filter((operation) => operation.type === 'add').length, 2);

  const summary = summarizeDiff(before, after);
  assert.equal(summary.added, 2);
  assert.equal(summary.removed, 1);
  assert.equal(summary.changed, true);

  const diff = formatUnifiedDiff({ path: 'src/app.js', oldText: before, newText: after });
  assert.match(diff, /--- a\/src\/app\.js/);
  assert.match(diff, /\+\+\+ b\/src\/app\.js/);
  assert.match(diff, /-dois/);
  assert.match(diff, /\+DOIS/);
});

test('arquivo idêntico não gera diff', () => {
  assert.equal(formatUnifiedDiff({ path: 'a.js', oldText: 'x\n', newText: 'x\n' }), '');
});
