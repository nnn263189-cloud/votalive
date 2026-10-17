import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadEnvFile } from '../src/env-file.js';

test('lê pares do .env e não sobrescreve o ambiente', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'votalive-env-'));
  const filePath = path.join(directory, '.env');
  try {
    await writeFile(filePath, [
      '# comentário',
      '',
      'EXPERIENTIAL_API_KEY=xpl_abc',
      'ESPACOS="valor com espaço"',
      "ASPAS='outro valor'",
      'ADMIN_TOKEN=do-ambiente',
      'linha sem igual',
    ].join('\n'), 'utf8');

    const env = { ADMIN_TOKEN: 'do-ambiente' };
    const result = await loadEnvFile(filePath, env);

    assert.equal(result.loaded, 3);
    assert.equal(env.EXPERIENTIAL_API_KEY, 'xpl_abc');
    assert.equal(env.ESPACOS, 'valor com espaço');
    assert.equal(env.ASPAS, 'outro valor');
    assert.equal(env.ADMIN_TOKEN, 'do-ambiente', 'o ambiente real tem prioridade');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('arquivo ausente não quebra nada', async () => {
  const env = { A: '1' };
  const result = await loadEnvFile('/caminho/que/nao/existe/.env', env);
  assert.equal(result.loaded, 0);
  assert.deepEqual(env, { A: '1' });
});
