import { spawn } from 'node:child_process';

import { formatUnifiedDiff, summarizeDiff } from './diff.js';
import {
  deleteFile as deleteWorkspaceFile,
  fileExists,
  listFiles,
  readTextFile,
  resolveSafePath,
  writeTextFile,
} from './workspace.js';

const MAX_TOOL_OUTPUT = 60_000;
const MAX_TEST_OUTPUT = 40_000;

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista os arquivos do projeto VotaLive. Use antes de editar para conhecer a estrutura.',
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Pasta opcional, relativa à raiz do projeto (ex.: "src", "public").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lê o conteúdo de um arquivo do projeto. Sempre leia antes de editar.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo à raiz do projeto.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Escreve (cria ou substitui) um arquivo do projeto. A mudança fica pendente até o humano aprovar.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo à raiz do projeto.' },
          content: { type: 'string', description: 'Conteúdo completo do novo arquivo.' },
          reason: { type: 'string', description: 'Por que essa mudança é necessária.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Substitui um trecho exato de um arquivo. A mudança fica pendente até o humano aprovar.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo à raiz do projeto.' },
          find: { type: 'string', description: 'Trecho exato a ser substituído.' },
          replace: { type: 'string', description: 'Texto novo.' },
          reason: { type: 'string', description: 'Por que essa mudança é necessária.' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Remove um arquivo do projeto. A mudança fica pendente até o humano aprovar.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo à raiz do projeto.' },
          reason: { type: 'string', description: 'Por que essa remoção é necessária.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Roda a suíte de testes do projeto e devolve a saída. Use depois de propor mudanças.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

export const AGENT_SYSTEM_PROMPT = [
  'Você é o engenheiro de software do projeto VotaLive (Node.js 22, ES modules, sem build, testes com node --test).',
  'Você trabalha dentro da raiz do projeto: leia os arquivos antes de mexer, respeite o estilo existente e escreva em português.',
  'Regras obrigatórias:',
  '- Use list_files e read_file para entender o código; nunca invente o conteúdo de um arquivo.',
  '- Qualquer escrita, edição ou remoção é apenas uma PROPOSTA: ela fica pendente até uma pessoa aprovar no painel.',
  '- Faça a menor mudança possível, em poucos arquivos, e mantenha os testes do projeto passando.',
  '- Depois de propor mudanças, chame run_tests e corrija o que falhar.',
  '- Ao final, explique em uma ou duas frases o que você mudou e por quê.',
].join('\n');

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n… (saída truncada)` : value;
}

async function currentContent(workspace, session, relativePath) {
  const staged = session.pending.get(relativePath);
  if (staged) {
    return { content: staged.action === 'delete' ? '' : staged.content, fromDisk: false };
  }
  const resolved = await resolveSafePath(workspace.root, relativePath);
  if (!(await fileExists(resolved.absolute))) return { content: null, fromDisk: true };
  const file = await readTextFile(workspace.root, relativePath, { maxBytes: MAX_TOOL_OUTPUT });
  return { content: file.content, fromDisk: true };
}

/** Executa o comando de teste configurado dentro do workspace. */
export function runTestCommand(workspace, { command, timeoutMs = 180_000 } = {}) {
  const testCommand = command || workspace.testCommand || 'npm test';
  return new Promise((resolve) => {
    const child = spawn(testCommand, {
      cwd: workspace.root,
      shell: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });

    let output = '';
    const collect = (chunk) => {
      output += String(chunk);
      if (output.length > MAX_TEST_OUTPUT * 2) output = output.slice(-MAX_TEST_OUTPUT);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, command: testCommand, output: `Erro ao iniciar o comando: ${error.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        command: testCommand,
        output: clip(output.trim(), MAX_TEST_OUTPUT),
      });
    });
  });
}

function buildDiff(relativePath, previous, next) {
  return formatUnifiedDiff({
    path: relativePath,
    oldText: previous ?? '',
    newText: next ?? '',
  });
}

/**
 * Roda o agente de código. As chamadas de escrita/edição/removal só entram
 * na sessão como "pendentes": nada é gravado no disco sem aprovação.
 */
export async function runAgent({
  gateway,
  workspace,
  session,
  prompt,
  model,
  maxSteps = 12,
  testCommand,
  onEvent = () => {},
}) {
  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...session.history,
    { role: 'user', content: String(prompt ?? '').trim() || 'Descreva o que deseja fazer.' },
  ];

  const steps = [];
  let usage = null;

  for (let step = 0; step < maxSteps; step += 1) {
    const reply = await gateway.chat({ messages, model, tools: AGENT_TOOLS });
    if (reply.usage) usage = reply.usage;

    const assistantMessage = { role: 'assistant', content: reply.text || '' };
    if (reply.toolCalls.length > 0) {
      assistantMessage.tool_calls = reply.toolCalls.map((call) => call.raw);
    }
    messages.push(assistantMessage);

    const stepRecord = {
      step: step + 1,
      text: reply.text || '',
      toolCalls: [],
    };
    onEvent({ type: 'model', step: stepRecord.step, text: stepRecord.text });

    if (reply.toolCalls.length === 0) {
      steps.push(stepRecord);
      break;
    }

    for (const call of reply.toolCalls) {
      const result = await executeTool({ call, workspace, session, testCommand });
      stepRecord.toolCalls.push({ name: call.name, arguments: call.arguments, result });
      onEvent({ type: 'tool', step: stepRecord.step, name: call.name, result });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: clip(JSON.stringify(result), MAX_TOOL_OUTPUT),
      });
    }

    steps.push(stepRecord);
  }

  // O histórico guarda só as falas de texto: turnos com tool_calls sem o
  // resultado correspondente confundiriam o modelo na conversa seguinte.
  session.history = messages
    .filter((message) => message.role !== 'system' && message.role !== 'tool')
    .filter((message) => !message.tool_calls)
    .slice(-24);

  return { steps, usage, pending: listPending(session) };
}

/** Executa uma chamada de ferramenta do agente. */
export async function executeTool({ call, workspace, session, testCommand }) {
  const args = call.arguments || {};
  try {
    switch (call.name) {
      case 'list_files': {
        const files = await listFiles(workspace.root, { subdirectory: args.directory || '' });
        return { ok: true, files: files.slice(0, 300) };
      }
      case 'read_file': {
        const file = await readTextFile(workspace.root, args.path, { maxBytes: MAX_TOOL_OUTPUT });
        return { ok: true, path: file.path, content: file.content, bytes: file.bytes, truncated: file.truncated };
      }
      case 'write_file': {
        return stageChange({ workspace, session, action: 'write', path: args.path, content: args.content, reason: args.reason });
      }
      case 'edit_file': {
        return stageChange({ workspace, session, action: 'edit', path: args.path, find: args.find, replace: args.replace, reason: args.reason });
      }
      case 'delete_file': {
        return stageChange({ workspace, session, action: 'delete', path: args.path, reason: args.reason });
      }
      case 'run_tests': {
        const result = await runTestCommand(workspace, { command: testCommand });
        return { ok: result.ok, code: result.code, command: result.command, output: result.output };
      }
      default:
        return { ok: false, error: `Ferramenta desconhecida: ${call.name}` };
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function stageChange({ workspace, session, action, path, content, find, replace, reason }) {
  const relative = String(path ?? '').trim();
  if (!relative) return { ok: false, error: 'Informe o caminho do arquivo.' };

  // Valida o caminho ANTES de propor a mudança: nada de escapar do projeto.
  let resolved;
  try {
    resolved = await resolveSafePath(workspace.root, relative);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  const relativePath = resolved.relative;

  const existing = await currentContent(workspace, session, relativePath);
  const previous = existing.content ?? '';
  const existed = existing.content !== null;

  let next = previous;
  if (action === 'write') {
    next = String(content ?? '');
  } else if (action === 'edit') {
    const needle = String(find ?? '');
    if (!needle) return { ok: false, error: 'Informe o trecho exato a substituir (find).' };
    const position = previous.indexOf(needle);
    if (position === -1) {
      return {
        ok: false,
        error: `Trecho não encontrado em ${relativePath}. Leia o arquivo e tente de novo com o texto exato.`,
      };
    }
    next = previous.slice(0, position) + String(replace ?? '') + previous.slice(position + needle.length);
  } else if (action === 'delete') {
    next = '';
  }

  const diff = buildDiff(relativePath, existed ? previous : '', next);
  const summary = summarizeDiff(existed ? previous : '', next);

  session.pending.set(relativePath, {
    path: relativePath,
    action,
    content: next,
    previous: existed ? previous : null,
    existed,
    reason: String(reason ?? '').trim(),
    diff,
    summary,
    createdAt: Date.now(),
  });

  return {
    ok: true,
    staged: true,
    path: relativePath,
    action,
    message: action === 'delete'
      ? `Remoção de ${relativePath} pendente de aprovação.`
      : `Mudança em ${relativePath} pendente de aprovação.`,
    diff,
  };
}

/** Lista as mudanças pendentes de uma sessão. */
export function listPending(session) {
  return [...session.pending.values()].map((change) => ({
    path: change.path,
    action: change.action,
    reason: change.reason,
    diff: change.diff,
    summary: change.summary,
    createdAt: change.createdAt,
  }));
}

/** Aplica as mudanças pendentes aprovadas. Só é chamado após o clique do humano. */
export async function applyPending(workspace, session) {
  const applied = [];
  const failed = [];
  for (const change of session.pending.values()) {
    try {
      if (change.action === 'delete') {
        const result = await deleteWorkspaceFile(workspace.root, change.path);
        applied.push(result);
      } else {
        const result = await writeTextFile(workspace.root, change.path, change.content);
        applied.push(result);
      }
    } catch (error) {
      failed.push({ path: change.path, error: String(error?.message || error) });
    }
  }
  if (failed.length === 0) session.pending.clear();
  else {
    for (const failure of failed) session.pending.delete(failure.path);
  }
  return { applied, failed };
}

/** Descarta as mudanças pendentes. */
export function discardPending(session) {
  const discarded = [...session.pending.keys()];
  session.pending.clear();
  return discarded;
}
