const state = {
  status: null,
  token: sessionStorage.getItem('votalive-admin-token') || '',
  mode: 'chat',
  messages: [],
  sessionId: null,
  pending: [],
  sending: false,
};

const elements = {
  badgeKey: document.getElementById('badgeKey'),
  badgeModel: document.getElementById('badgeModel'),
  brandSub: document.getElementById('brandSub'),
  tokenBox: document.getElementById('tokenBox'),
  adminToken: document.getElementById('adminToken'),
  btnToken: document.getElementById('btnToken'),
  tabs: document.getElementById('tabs'),
  panelTitle: document.getElementById('panelTitle'),
  panelHint: document.getElementById('panelHint'),
  chatView: document.getElementById('chatView'),
  imageView: document.getElementById('imageView'),
  decisionView: document.getElementById('decisionView'),
  messages: document.getElementById('messages'),
  prompt: document.getElementById('prompt'),
  btnSend: document.getElementById('btnSend'),
  composerHint: document.getElementById('composerHint'),
  imagePrompt: document.getElementById('imagePrompt'),
  imageModel: document.getElementById('imageModel'),
  imageSize: document.getElementById('imageSize'),
  btnImage: document.getElementById('btnImage'),
  imageResult: document.getElementById('imageResult'),
  decisionInput: document.getElementById('decisionInput'),
  decisionType: document.getElementById('decisionType'),
  decisionName: document.getElementById('decisionName'),
  decisionInstructions: document.getElementById('decisionInstructions'),
  choiceBlock: document.getElementById('choiceBlock'),
  choiceRows: document.getElementById('choiceRows'),
  scoreBlock: document.getElementById('scoreBlock'),
  scoreRows: document.getElementById('scoreRows'),
  btnAddChoice: document.getElementById('btnAddChoice'),
  btnAddLevel: document.getElementById('btnAddLevel'),
  btnDecision: document.getElementById('btnDecision'),
  decisionResult: document.getElementById('decisionResult'),
  pendingBox: document.getElementById('pendingBox'),
  pendingHint: document.getElementById('pendingHint'),
  btnTests: document.getElementById('btnTests'),
  testBox: document.getElementById('testBox'),
  fileList: document.getElementById('fileList'),
  fileView: document.getElementById('fileView'),
  workspaceName: document.getElementById('workspaceName'),
  toast: document.getElementById('toast'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

let toastTimer = null;
function toast(message, kind = '') {
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 4200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers['x-admin-token'] = state.token;

  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/* ------------------------------------------------------------------ status */

async function loadStatus() {
  try {
    const status = await api('/api/ai/status');
    state.status = status;
    elements.badgeModel.textContent = `modelo: ${status.chatModel}`;
    elements.workspaceName.textContent = status.workspaceRoot.split('/').pop() || 'projeto';
    elements.imageModel.value = status.imageModel;
    elements.panelHint.textContent = status.chatModel;
    if (status.configured) {
      elements.badgeKey.textContent = 'chave: configurada';
      elements.badgeKey.className = 'badge ok';
    } else {
      elements.badgeKey.textContent = 'chave: faltando EXPERIENTIAL_API_KEY';
      elements.badgeKey.className = 'badge bad';
      toast('Defina EXPERIENTIAL_API_KEY no servidor para o app de IA funcionar.', 'bad');
    }
    if (status.authRequired) {
      elements.tokenBox.hidden = false;
      elements.adminToken.value = state.token;
      if (state.token) await refreshFiles();
    }
  } catch (error) {
    elements.badgeKey.textContent = 'gateway: erro';
    elements.badgeKey.className = 'badge bad';
    toast(error.message, 'bad');
  }
}

elements.btnToken.addEventListener('click', async () => {
  state.token = elements.adminToken.value.trim();
  sessionStorage.setItem('votalive-admin-token', state.token);
  toast(state.token ? 'Token liberado para esta aba.' : 'Token apagado.');
  await refreshFiles();
});

/* ------------------------------------------------------------------- modos */

const MODE_LABELS = {
  chat: ['Conversa', 'perguntas, ideias e texto'],
  image: ['Criar imagem', 'gera imagens pelo gateway'],
  code: ['Mudar o código', 'o agente propõe, você aprova'],
  decision: ['Decisão tipada', 'gpt-6-luna-decisions'],
};

function setMode(mode) {
  state.mode = mode;
  for (const tab of elements.tabs.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  }
  elements.chatView.hidden = mode !== 'chat' && mode !== 'code';
  elements.imageView.hidden = mode !== 'image';
  elements.decisionView.hidden = mode !== 'decision';
  const [title, hint] = MODE_LABELS[mode];
  elements.panelTitle.textContent = title;
  elements.panelHint.textContent = mode === 'decision'
    ? state.status?.decisionsModel || 'gpt-6-luna-decisions'
    : state.status?.chatModel || '';
  elements.composerHint.textContent = mode === 'code'
    ? 'O agente lê o projeto, propõe mudanças e roda os testes. Nada é gravado sem você aprovar.'
    : 'Enter envia · Shift+Enter quebra a linha';
  elements.btnSend.textContent = mode === 'code' ? 'Propor mudança' : 'Enviar';
  if (mode === 'code') elements.messages.scrollTop = elements.messages.scrollHeight;
}

elements.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) setMode(tab.dataset.mode);
});

/* ------------------------------------------------------------------ mensagens */

function renderMessages() {
  if (state.messages.length === 0) {
    elements.messages.innerHTML = '<div class="empty">Comece uma conversa. O histórico fica só nesta aba.</div>';
    return;
  }
  const parts = state.messages.map((message) => {
    if (message.kind === 'steps') {
      const steps = message.steps.map((step) => {
        const tools = (step.toolCalls || []).map((tool) => {
          const detail = tool.result?.error
            || tool.result?.message
            || (tool.result?.files ? `${tool.result.files.length} arquivos` : '')
            || (tool.result?.content ? `${tool.result.content.length} caracteres lidos` : '')
            || 'ok';
          return `<div class="step"><div class="tool">${escapeHtml(tool.name)}</div><div class="detail">${escapeHtml(detail)}</div></div>`;
        }).join('');
        return `<div class="step"><div class="tool">passo ${step.step}</div>${step.text ? `<div class="detail">${escapeHtml(step.text)}</div>` : ''}${tools}</div>`;
      }).join('');
      return `<div class="msg"><div class="who">agente</div>${steps}</div>`;
    }
    if (message.kind === 'error') {
      return `<div class="msg error"><div class="who">erro</div><div class="text">${escapeHtml(message.text)}</div></div>`;
    }
    return `<div class="msg ${message.role}"><div class="who">${escapeHtml(message.role === 'user' ? 'você' : 'assistente')}</div><div class="text">${escapeHtml(message.text)}</div></div>`;
  });
  elements.messages.innerHTML = parts.join('');
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function pushMessage(message) {
  state.messages.push(message);
  renderMessages();
}

/* ----------------------------------------------------------------- streaming */

async function streamChat(prompt) {
  const history = state.messages
    .filter((message) => message.kind === 'message')
    .map((message) => ({ role: message.role, content: message.text }));
  history.push({ role: 'user', content: prompt });

  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-admin-token': state.token } : {}),
    },
    body: JSON.stringify({ messages: history }),
  });

  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    throw new Error(payload?.message || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const assistant = { kind: 'message', role: 'assistant', text: '' };
  state.messages.push(assistant);
  renderMessages();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');

      const eventLine = raw.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7).trim();
      let data = {};
      try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }

      if (event === 'delta') {
        assistant.text += data.text || '';
        renderMessages();
      } else if (event === 'error') {
        assistant.text += `\n[erro] ${data.message}`;
        renderMessages();
      } else if (event === 'done') {
        if (data.usage) {
          const usage = data.usage;
          assistant.text += `\n\n_tokens: entrada ${usage.input_tokens ?? '?'} · saída ${usage.output_tokens ?? '?'}`;
          renderMessages();
        }
      }
    }
  }
}

/* --------------------------------------------------------------------- agente */

async function runCodeAgent(prompt) {
  const response = await fetch('/api/ai/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-admin-token': state.token } : {}),
    },
    body: JSON.stringify({ prompt, sessionId: state.sessionId }),
  });

  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);

  state.sessionId = payload.sessionId || state.sessionId;
  state.pending = payload.pending || [];
  renderPending();
  pushMessage({ kind: 'steps', steps: payload.steps || [] });
  if (payload.usage) {
    const usage = payload.usage;
    pushMessage({
      kind: 'message',
      role: 'assistant',
      text: `_tokens: entrada ${usage.input_tokens ?? '?'} · saída ${usage.output_tokens ?? '?'}`,
    });
  }
  await refreshFiles();
}

/* ------------------------------------------------------------------- envio */

elements.btnSend.addEventListener('click', send);
elements.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

async function send() {
  if (state.sending) return;
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;

  elements.prompt.value = '';
  state.sending = true;
  elements.btnSend.disabled = true;
  pushMessage({ kind: 'message', role: 'user', text: prompt });

  try {
    if (state.mode === 'code') {
      await runCodeAgent(prompt);
    } else {
      await streamChat(prompt);
    }
  } catch (error) {
    pushMessage({ kind: 'error', text: error.message });
  } finally {
    state.sending = false;
    elements.btnSend.disabled = false;
  }
}

/* -------------------------------------------------------------------- imagem */

elements.btnImage.addEventListener('click', async () => {
  const prompt = elements.imagePrompt.value.trim();
  if (!prompt) {
    toast('Escreva o prompt da imagem.', 'bad');
    return;
  }
  elements.btnImage.disabled = true;
  elements.imageResult.innerHTML = '<div class="small">Gerando…</div>';
  try {
    const result = await api('/api/ai/image', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        model: elements.imageModel.value.trim() || undefined,
        size: elements.imageSize.value || undefined,
      }),
    });
    const parts = [];
    for (const image of result.images) {
      parts.push(`<img class="img-preview" alt="Imagem gerada" src="${escapeHtml(image)}">`);
    }
    if (result.text) parts.push(`<div class="msg"><div class="who">modelo</div><div class="text">${escapeHtml(result.text)}</div></div>`);
    if (result.usage) {
      parts.push(`<div class="small">_tokens: entrada ${result.usage.input_tokens ?? '?'} · saída ${result.usage.output_tokens ?? '?'}</div>`);
    }
    for (const failure of result.failed || []) {
      parts.push(`<div class="small">Não consegui embutir uma imagem: ${escapeHtml(failure.error || '')}</div>`);
    }
    elements.imageResult.innerHTML = parts.join('') || '<div class="small">O modelo não devolveu imagem.</div>';
  } catch (error) {
    elements.imageResult.innerHTML = `<div class="msg error"><div class="who">erro</div><div class="text">${escapeHtml(error.message)}</div></div>`;
  } finally {
    elements.btnImage.disabled = false;
  }
});

/* ------------------------------------------------------------------ decisão */

function addChoiceRow(value = '', description = '') {
  const row = document.createElement('div');
  row.className = 'option-row';
  row.innerHTML = `
    <input type="text" class="choice-value" placeholder="valor" value="${escapeHtml(value)}">
    <input type="text" class="choice-description" placeholder="descrição" value="${escapeHtml(description)}">
    <button class="btn" type="button" data-remove>✕</button>`;
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  elements.choiceRows.appendChild(row);
}

function addLevelRow(label = '', description = '') {
  const row = document.createElement('div');
  row.className = 'option-row';
  row.innerHTML = `
    <input type="text" class="level-label" placeholder="rótulo" value="${escapeHtml(label)}">
    <input type="text" class="level-description" placeholder="descrição" value="${escapeHtml(description)}">
    <button class="btn" type="button" data-remove>✕</button>`;
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  elements.scoreRows.appendChild(row);
}

elements.btnAddChoice.addEventListener('click', () => addChoiceRow());
elements.btnAddLevel.addEventListener('click', () => addLevelRow());

elements.decisionType.addEventListener('change', () => {
  const type = elements.decisionType.value;
  elements.choiceBlock.hidden = type !== 'choice';
  elements.scoreBlock.hidden = type !== 'score';
});

elements.btnDecision.addEventListener('click', async () => {
  const type = elements.decisionType.value;
  const question = {
    type,
    instructions: elements.decisionInstructions.value.trim(),
  };
  if (elements.decisionName.value.trim()) question.name = elements.decisionName.value.trim();

  if (type === 'choice') {
    question.choices = [...elements.choiceRows.querySelectorAll('.option-row')].map((row) => {
      const value = row.querySelector('.choice-value').value.trim();
      const description = row.querySelector('.choice-description').value.trim();
      return description ? { value, description } : { value };
    }).filter((choice) => choice.value);
  }
  if (type === 'score') {
    question.levels = [...elements.scoreRows.querySelectorAll('.option-row')].map((row) => {
      const label = row.querySelector('.level-label').value.trim();
      const description = row.querySelector('.level-description').value.trim();
      return description ? { label, description } : { label };
    }).filter((level) => level.label);
  }

  elements.btnDecision.disabled = true;
  elements.decisionResult.innerHTML = '<div class="small">Consultando…</div>';
  try {
    const result = await api('/api/ai/decision', {
      method: 'POST',
      body: JSON.stringify({
        input: elements.decisionInput.value.trim(),
        questions: [question],
        name: question.name,
      }),
    });
    const answer = result.answer || {};
    const parts = [`<div class="result"><div class="metric"><span>tipo</span><strong>${escapeHtml(answer.type || '-')}</strong></div>`];
    if (answer.choice !== undefined && answer.choice !== null) {
      parts.push(`<div class="metric"><span>escolha</span><strong>${escapeHtml(String(answer.choice))}</strong></div>`);
    }
    if (typeof answer.probability === 'number') {
      parts.push(`<div class="metric"><span>probabilidade</span><strong>${(answer.probability * 100).toFixed(1)}%</strong></div>`);
    }
    if (typeof answer.score === 'number') {
      parts.push(`<div class="metric"><span>nota</span><strong>${answer.score}</strong></div>`);
    }
    if (typeof answer.confidence === 'number') {
      parts.push(`<div class="metric"><span>confiança</span><strong>${(answer.confidence * 100).toFixed(1)}%</strong></div>`);
    }
    parts.push(`<div class="small" style="margin-top:8px">${escapeHtml(answer.summary || '')}</div>`);

    const probabilities = Array.isArray(answer.probabilities) ? answer.probabilities : [];
    if (probabilities.length > 0) {
      parts.push('<div class="prob">');
      for (const item of probabilities) {
        const label = item.label ?? item.value ?? '-';
        const probability = Number(item.probability ?? 0);
        parts.push(
          `<div class="prob-line"><span>${escapeHtml(String(label))}</span>`
          + `<span class="bar"><i style="width:${Math.max(0, Math.min(1, probability)) * 100}%"></i></span>`
          + `<span>${(probability * 100).toFixed(1)}%</span></div>`,
        );
      }
      parts.push('</div>');
    }
    parts.push('</div>');

    if (result.usage) {
      const usage = result.usage;
      parts.push(`<div class="small" style="margin-top:8px">_tokens: entrada ${usage.input_tokens ?? '?'} · saída ${usage.output_tokens ?? '?'} · total ${usage.total_tokens ?? '?'}</div>`);
    }
    parts.push('<div class="small" style="margin-top:6px">Probabilidade e confiança não são garantia de acerto. Nada é executado automaticamente.</div>');
    elements.decisionResult.innerHTML = parts.join('');
  } catch (error) {
    elements.decisionResult.innerHTML = `<div class="msg error"><div class="who">erro</div><div class="text">${escapeHtml(error.message)}</div></div>`;
  } finally {
    elements.btnDecision.disabled = false;
  }
});

/* ------------------------------------------------------- mudanças pendentes */

function renderPending() {
  if (!state.pending || state.pending.length === 0) {
    elements.pendingBox.innerHTML = '<div class="empty">Nenhuma mudança esperando aprovação.</div>';
    return;
  }
  const cards = state.pending.map((change) => {
    const diff = String(change.diff || '')
      .split('\n')
      .map((line) => {
        if (line.startsWith('@@')) return `<div class="hunk">${escapeHtml(line)}</div>`;
        if (line.startsWith('+++') || line.startsWith('---')) return `<div class="ctx">${escapeHtml(line)}</div>`;
        if (line.startsWith('+')) return `<div class="add">${escapeHtml(line)}</div>`;
        if (line.startsWith('-')) return `<div class="del">${escapeHtml(line)}</div>`;
        return `<div class="ctx">${escapeHtml(line)}</div>`;
      })
      .join('');
    const summary = change.summary || {};
    return `<div class="change">
      <div class="change-head">
        <strong>${escapeHtml(change.path)}</strong>
        <span class="small">${escapeHtml(change.action)} · +${summary.added ?? 0}/-${summary.removed ?? 0}</span>
      </div>
      <pre class="diff">${diff || '(sem diferenças de texto)'}</pre>
    </div>`;
  }).join('');

  elements.pendingBox.innerHTML = `<div class="changes">${cards}</div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn primary" id="btnApply">Aplicar alterações</button>
      <button class="btn" id="btnDiscard">Descartar</button>
    </div>`;

  document.getElementById('btnApply').addEventListener('click', applyChanges);
  document.getElementById('btnDiscard').addEventListener('click', discardChanges);
}

async function applyChanges() {
  try {
    const result = await api('/api/ai/apply', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    state.pending = result.pending || [];
    renderPending();
    await refreshFiles();
    const applied = (result.applied || []).length;
    const failed = (result.failed || []).length;
    toast(failed === 0 ? `${applied} arquivo(s) alterado(s).` : `${failed} alteração(ões) falharam.`, failed === 0 ? '' : 'bad');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function discardChanges() {
  try {
    await api('/api/ai/discard', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    state.pending = [];
    renderPending();
    toast('Mudanças pendentes descartadas.');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/* ------------------------------------------------------------------- testes */

elements.btnTests.addEventListener('click', async () => {
  elements.btnTests.disabled = true;
  elements.testBox.innerHTML = '<div class="small">Rodando…</div>';
  try {
    const result = await api('/api/ai/tests', { method: 'POST', body: JSON.stringify({}) });
    elements.testBox.innerHTML = `<div class="small">${result.ok ? '✅ testes passaram' : '❌ testes falharam'} · <code>${escapeHtml(result.command)}</code></div>
      <div class="test-out">${escapeHtml(result.output || '(sem saída)')}</div>`;
  } catch (error) {
    elements.testBox.innerHTML = `<div class="small">erro: ${escapeHtml(error.message)}</div>`;
  } finally {
    elements.btnTests.disabled = false;
  }
});

/* ------------------------------------------------------------------ arquivos */

async function refreshFiles() {
  try {
    const result = await api('/api/ai/files');
    const files = (result.files || []).filter((file) => file.kind === 'file');
    elements.fileList.innerHTML = files.map((file) => `
      <div class="file-item" data-path="${escapeHtml(file.path)}">
        <span class="path">${escapeHtml(file.path)}</span>
        <span class="size">${file.size} B</span>
      </div>`).join('') || '<div class="empty">Nenhum arquivo.</div>';
  } catch (error) {
    elements.fileList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

elements.fileList.addEventListener('click', async (event) => {
  const item = event.target.closest('.file-item');
  if (!item) return;
  try {
    const file = await api(`/api/ai/file?path=${encodeURIComponent(item.dataset.path)}`);
    elements.fileView.innerHTML = `<div class="small" style="margin-bottom:6px">${escapeHtml(file.path)} · ${file.bytes} bytes</div>
      <pre class="view">${escapeHtml(file.content)}</pre>`;
  } catch (error) {
    elements.fileView.innerHTML = `<div class="small">erro: ${escapeHtml(error.message)}</div>`;
  }
});

/* -------------------------------------------------------------------- início */

addChoiceRow('accept', 'A mudança está correta e testada.');
addChoiceRow('review', 'Faltam evidências ou testes.');
addLevelRow('baixo', 'Impacto pequeno.');
addLevelRow('médio', 'Impacto parcial.');
addLevelRow('alto', 'Quebra o uso.');

renderMessages();
setMode('chat');
loadStatus();
