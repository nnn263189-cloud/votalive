/**
 * Diff unificado enxuto para pré-visualizar as mudanças propostas pelo agente.
 * Usa prefixo/sufaxe comuns e, quando o miolo é pequeno, um LCS linha a linha.
 */

const MAX_LCS_LINES = 600;

function splitLines(text) {
  if (text === '') return [];
  const normalized = String(text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function endsWithNewline(text) {
  return typeof text === 'string' && (text === '' || text.endsWith('\n'));
}

function commonPrefix(a, b) {
  let index = 0;
  const max = Math.min(a.length, b.length);
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffix(a, b, prefix) {
  let index = 0;
  const max = Math.min(a.length, b.length) - prefix;
  while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}

function lcsDiff(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const width = m + 1;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      operations.push({ type: 'context', line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      operations.push({ type: 'remove', line: oldLines[i] });
      i += 1;
    } else {
      operations.push({ type: 'add', line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    operations.push({ type: 'remove', line: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    operations.push({ type: 'add', line: newLines[j] });
    j += 1;
  }
  return operations;
}

/** Lista de operações de linha: context, remove, add. */
export function diffLines(oldText, newText) {
  const oldLines = splitLines(oldText ?? '');
  const newLines = splitLines(newText ?? '');

  const prefix = commonPrefix(oldLines, newLines);
  const suffix = commonSuffix(oldLines, newLines, prefix);

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  const operations = [];
  for (let index = 0; index < prefix; index += 1) {
    operations.push({ type: 'context', line: oldLines[index] });
  }

  if (oldMiddle.length <= MAX_LCS_LINES && newMiddle.length <= MAX_LCS_LINES) {
    operations.push(...lcsDiff(oldMiddle, newMiddle));
  } else {
    oldMiddle.forEach((line) => operations.push({ type: 'remove', line }));
    newMiddle.forEach((line) => operations.push({ type: 'add', line }));
  }

  for (let index = oldLines.length - suffix; index < oldLines.length; index += 1) {
    operations.push({ type: 'context', line: oldLines[index] });
  }

  return operations;
}

/** Diff unificado no formato de patch, limitado a um número de linhas de contexto. */
export function formatUnifiedDiff({ path: filePath, oldText = '', newText = '', contextLines = 3 }) {
  const operations = diffLines(oldText, newText);
  const sameEnding = endsWithNewline(oldText) === endsWithNewline(newText);
  if (operations.every((operation) => operation.type === 'context') && sameEnding) return '';

  const interesting = operations
    .map((operation, index) => (operation.type === 'context' ? -1 : index))
    .filter((index) => index >= 0);

  let first;
  let last;
  if (interesting.length === 0) {
    // Só o fim de linha mudou: mostra a última linha.
    first = Math.max(0, operations.length - 1);
    last = operations.length - 1;
  } else {
    first = Math.max(0, Math.min(...interesting) - contextLines);
    last = Math.min(operations.length - 1, Math.max(...interesting) + contextLines);
  }

  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let oldCount = 0;
  let newCount = 0;
  for (let index = first; index <= last; index += 1) {
    const operation = operations[index];
    if (operation.type === 'context') {
      lines.push(` ${operation.line}`);
      oldCount += 1;
      newCount += 1;
    } else if (operation.type === 'remove') {
      lines.push(`-${operation.line}`);
      oldCount += 1;
    } else {
      lines.push(`+${operation.line}`);
      newCount += 1;
    }
  }

  let oldStart = 1;
  let newStart = 1;
  for (let index = 0; index < first; index += 1) {
    const operation = operations[index];
    if (operation.type === 'context' || operation.type === 'remove') oldStart += 1;
    if (operation.type === 'context' || operation.type === 'add') newStart += 1;
  }

  const hunk = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  lines.splice(2, 0, hunk);
  if (endsWithNewline(oldText) !== endsWithNewline(newText)) {
    lines.push('\\ No newline at end of file');
  }
  return `${lines.join('\n')}\n`;
}

/** Resumo curto: quantas linhas entraram e saíram. */
export function summarizeDiff(oldText = '', newText = '') {
  const operations = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const operation of operations) {
    if (operation.type === 'add') added += 1;
    if (operation.type === 'remove') removed += 1;
  }
  return { added, removed, changed: added > 0 || removed > 0 };
}
