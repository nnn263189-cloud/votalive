const candidateDefinitions = [
  { id: 'A', name: 'Lula', party: 'PT - 13', photo: 'img/lula.jpg', style: 'a' },
  { id: 'B', name: 'Flavio Bolsonaro', party: 'PL - 22', photo: 'img/flavio.jpg', style: 'b' },
];

const emptyState = {
  revision: 0,
  session: null,
  scores: { A: 0, B: 0 },
  totalPoints: 0,
  totalGifts: 0,
  totalEvents: 0,
  totalParticipants: 0,
  unmappedGifts: 0,
  activity: [],
};

const elements = {
  activity: document.getElementById('activity'),
  adminToken: document.getElementById('adminToken'),
  authPanel: document.getElementById('authPanel'),
  authStatus: document.getElementById('authStatus'),
  btnAuth: document.getElementById('btnAuth'),
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  candidates: document.getElementById('candidates'),
  connectHint: document.getElementById('connectHint'),
  liveBadge: document.getElementById('liveBadge'),
  liveText: document.getElementById('liveText'),
  reset: document.getElementById('reset'),
  tiktokUser: document.getElementById('tiktokUser'),
  toast: document.getElementById('toast'),
  totalGifts: document.getElementById('totalGifts'),
  totalParticipants: document.getElementById('totalParticipants'),
  totalVotes: document.getElementById('totalVotes'),
};

let state = { ...emptyState, scores: { ...emptyState.scores }, activity: [] };
let connection = { phase: 'idle', username: null, roomId: null, message: null, attempt: 0 };
let socket = null;
let socketOnline = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let authRequired = false;
let authorized = false;
let pendingAuthToken = '';
let toastTimer = null;

const fmt = (value) => Number(value || 0).toLocaleString('pt-BR');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3_200);
}

function burst(symbol) {
  for (let index = 0; index < 12; index += 1) {
    const item = document.createElement('span');
    item.className = 'confetti';
    item.textContent = symbol;
    item.style.left = `${10 + Math.random() * 80}vw`;
    item.style.top = `${50 + Math.random() * 30}vh`;
    document.body.appendChild(item);
    setTimeout(() => item.remove(), 1_200);
  }
}

function candidateName(candidateId) {
  return candidateDefinitions.find((candidate) => candidate.id === candidateId)?.name || 'Candidato';
}

function renderActivity(item) {
  const who = item.nickname || item.username;
  const combo = Number(item.repeatCount) > 1 ? ` ×${fmt(item.repeatCount)}` : '';
  const source = item.source === 'simulation' ? ' · teste' : '';

  if (!item.recognized) {
    const detail = `${item.giftName}${combo}${who ? ` de @${who}` : ''}${source}`;
    return `<div class="activity-item activity-unmapped">
      <span class="activity-emoji">${escapeHtml(item.emoji || '🎁')}</span>
      <div class="activity-text"><strong>Presente não mapeado</strong>${escapeHtml(detail)}</div>
      <span class="activity-votes unmapped">sem pontos</span>
    </div>`;
  }

  const detail = `${item.giftName}${combo}${who ? ` de @${who}` : ''}${source}`;
  return `<div class="activity-item">
    <span class="activity-emoji">${escapeHtml(item.emoji || '🎁')}</span>
    <div class="activity-text"><strong>${escapeHtml(candidateName(item.candidateId))}</strong>${escapeHtml(detail)}</div>
    <span class="activity-votes">+${fmt(item.points)}</span>
  </div>`;
}

function render() {
  const scoreA = Number(state.scores?.A || 0);
  const scoreB = Number(state.scores?.B || 0);
  const totalPoints = scoreA + scoreB;

  elements.totalVotes.textContent = fmt(totalPoints);
  elements.totalGifts.textContent = fmt(state.totalGifts);
  elements.totalParticipants.textContent = fmt(state.totalParticipants);

  elements.candidates.innerHTML = candidateDefinitions.map((candidate) => {
    const votes = candidate.id === 'A' ? scoreA : scoreB;
    const percent = totalPoints ? (votes / totalPoints) * 100 : 0;
    const percentLabel = percent.toFixed(1).replace('.', ',');
    return `<article class="candidate ${candidate.style}">
      <div class="candidate-top">
        <img class="avatar" src="${escapeHtml(candidate.photo)}" alt="${escapeHtml(candidate.name)}" width="72" height="72">
        <div class="candidate-meta">
          <div class="party">${escapeHtml(candidate.party)}</div>
          <div class="candidate-name">${escapeHtml(candidate.name)}</div>
          <span class="badge-turno">2º Turno</span>
        </div>
        <div class="score"><strong>${percentLabel}%</strong><span>${fmt(votes)} pts</span></div>
      </div>
      <div class="bar" aria-label="${percentLabel} por cento"><div class="bar-fill" style="width:${percent}%"></div></div>
      <div class="candidate-foot"><span>${percentLabel}% do total</span><span>${fmt(votes)} pontos</span></div>
    </article>`;
  }).join('');

  const activity = Array.isArray(state.activity) ? state.activity.slice(0, 10) : [];
  elements.activity.innerHTML = activity.length
    ? activity.map(renderActivity).join('')
    : '<div class="empty">Os presentes da LIVE (e os de teste) aparecerão aqui.</div>';
}

function applyState(nextState) {
  if (!nextState || typeof nextState !== 'object') return;
  state = {
    ...emptyState,
    ...nextState,
    scores: { ...emptyState.scores, ...(nextState.scores || {}) },
    activity: Array.isArray(nextState.activity) ? nextState.activity : [],
  };
  render();
}

function canControl() {
  return socketOnline && (!authRequired || authorized);
}

function updateControls() {
  const enabled = canControl();
  const busy = ['connecting', 'reconnecting'].includes(connection.phase);
  elements.btnConnect.disabled = !enabled || busy;
  elements.btnDisconnect.disabled = !enabled;
  elements.reset.disabled = !enabled;
  document.querySelectorAll('[data-gift]').forEach((button) => {
    button.disabled = !enabled;
  });

  elements.authPanel.hidden = !authRequired;
  if (authRequired) {
    elements.authStatus.textContent = authorized
      ? 'Controles desbloqueados nesta aba.'
      : 'Informe o token de administrador para usar os controles.';
    elements.authStatus.className = authorized ? 'auth-status ok' : 'auth-status';
    elements.btnAuth.textContent = authorized ? 'Token aceito' : 'Desbloquear';
    elements.btnAuth.disabled = authorized || !socketOnline;
    elements.adminToken.disabled = authorized || !socketOnline;
  }
}

function setConnectionStatus(nextConnection, panelDisconnected = false) {
  if (nextConnection && typeof nextConnection === 'object') connection = nextConnection;
  const { phase, username, message, attempt } = connection;
  const badge = elements.liveBadge;
  badge.className = 'live';

  if (panelDisconnected) {
    badge.classList.add('error');
    elements.liveText.textContent = 'RECONECTANDO PAINEL…';
    elements.connectHint.textContent = 'O placar exibido foi preservado. Tentando recuperar a conexão com o servidor…';
    elements.btnConnect.style.display = '';
    elements.btnDisconnect.style.display = 'none';
  } else if (phase === 'connected') {
    badge.classList.add('online');
    elements.liveText.textContent = `AO VIVO · @${username || ''}`;
    elements.connectHint.textContent = 'Conectado. Presentes finalizados da LIVE entram no placar compartilhado em tempo real.';
    elements.btnConnect.style.display = 'none';
    elements.btnDisconnect.style.display = '';
    if (username && !elements.tiktokUser.value) elements.tiktokUser.value = `@${username}`;
  } else if (phase === 'connecting') {
    badge.classList.add('connecting');
    elements.liveText.textContent = 'CONECTANDO…';
    elements.connectHint.textContent = `Conectando a @${username || ''}…`;
    elements.btnConnect.style.display = '';
    elements.btnDisconnect.style.display = 'none';
  } else if (phase === 'reconnecting') {
    badge.classList.add('connecting');
    elements.liveText.textContent = 'RECONECTANDO À LIVE…';
    elements.connectHint.textContent = `A conexão caiu. Tentativa automática ${attempt || 1} para @${username || ''}…`;
    elements.btnConnect.style.display = 'none';
    elements.btnDisconnect.style.display = '';
  } else if (phase === 'ended') {
    badge.classList.add('error');
    elements.liveText.textContent = 'LIVE ENCERRADA';
    elements.connectHint.textContent = message || 'A LIVE terminou. O resultado foi preservado; conecte novamente quando a nova LIVE começar.';
    elements.btnConnect.style.display = '';
    elements.btnDisconnect.style.display = 'none';
  } else if (phase === 'error') {
    badge.classList.add('error');
    elements.liveText.textContent = 'ERRO';
    elements.connectHint.textContent = message || 'Falha na conexão. Confira se a LIVE está no ar e tente novamente.';
    elements.btnConnect.style.display = '';
    elements.btnDisconnect.style.display = 'none';
  } else {
    elements.liveText.textContent = 'DESCONECTADO';
    elements.connectHint.textContent = 'Digite o @ do criador que está ao vivo e clique em Conectar. O placar fica salvo no servidor.';
    elements.btnConnect.style.display = '';
    elements.btnDisconnect.style.display = 'none';
  }

  updateControls();
}

function readSavedToken() {
  try {
    return sessionStorage.getItem('votaliveAdminToken') || '';
  } catch {
    return '';
  }
}

function saveToken(token) {
  try {
    sessionStorage.setItem('votaliveAdminToken', token);
  } catch {
    // Private browsing can disable sessionStorage; authentication still works.
  }
}

function clearToken() {
  try {
    sessionStorage.removeItem('votaliveAdminToken');
  } catch {
    // Ignore unavailable sessionStorage.
  }
}

function authenticate(token) {
  if (!socketOnline || !token) return;
  pendingAuthToken = token;
  socket.send(JSON.stringify({ type: 'auth', token }));
}

function sendCommand(payload) {
  if (!socketOnline || socket?.readyState !== WebSocket.OPEN) {
    showToast('Reconectando ao servidor. Tente novamente em instantes.');
    connectWebSocket();
    return false;
  }
  if (authRequired && !authorized) {
    showToast('Informe o token de administrador para usar os controles.');
    elements.adminToken.focus();
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function handleGiftMessage(message) {
  const gift = message.gift;
  if (!gift) return;
  const combo = Number(gift.repeatCount) > 1 ? ` ×${fmt(gift.repeatCount)}` : '';
  if (gift.recognized) {
    const name = candidateName(gift.candidateId);
    showToast(`${gift.emoji || '🎁'} ${gift.giftName}${combo} → ${name}: +${fmt(gift.points)} pontos`);
    if (Number(gift.points) >= 1_000) burst(gift.emoji || '🎁');
  } else {
    showToast(`${gift.emoji || '🎁'} ${gift.giftName}${combo} recebido, mas não está mapeado.`);
  }
}

function handleMessage(message) {
  if (message.state) applyState(message.state);
  if (message.connection) setConnectionStatus(message.connection);

  if (message.type === 'hello') {
    authRequired = Boolean(message.authRequired);
    authorized = Boolean(message.authorized);
    updateControls();
    const savedToken = readSavedToken();
    if (authRequired && !authorized && savedToken) authenticate(savedToken);
    if (message.insecureControl && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      showToast('Aviso: os controles públicos estão sem ADMIN_TOKEN.');
    }
  } else if (message.type === 'auth_result') {
    authorized = Boolean(message.ok);
    if (authorized) {
      saveToken(pendingAuthToken || readSavedToken());
      elements.adminToken.value = '';
      showToast('Controles desbloqueados nesta aba.');
    } else {
      clearToken();
      showToast(message.message || 'Token incorreto.');
      elements.adminToken.select();
    }
    pendingAuthToken = '';
    updateControls();
  } else if (message.type === 'gift' || message.type === 'gift_ignored') {
    handleGiftMessage(message);
  } else if (message.type === 'session_started') {
    showToast('Nova LIVE detectada: uma nova sessão de votação foi iniciada.');
  } else if (message.type === 'reset') {
    showToast('Placar compartilhado zerado.');
  } else if (message.type === 'stream_ended') {
    showToast('A LIVE terminou. O resultado foi preservado.');
  } else if (message.type === 'connector_warning') {
    showToast(`TikTok: ${message.message}`);
  } else if (message.type === 'command_error') {
    if (message.code === 'unauthorized') authorized = false;
    showToast(message.message || 'Não foi possível executar o comando.');
    updateControls();
  }
}

function scheduleWebSocketReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(15_000, 1_000 * (2 ** Math.min(reconnectAttempts, 4)));
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(connectWebSocket, delay);
}

function connectWebSocket() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);

  socket.addEventListener('open', () => {
    socketOnline = true;
    reconnectAttempts = 0;
    updateControls();
  });
  socket.addEventListener('message', (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('[VotaLive] Mensagem inválida do servidor:', error);
    }
  });
  socket.addEventListener('close', () => {
    socketOnline = false;
    authorized = false;
    setConnectionStatus(connection, true);
    scheduleWebSocketReconnect();
  });
  socket.addEventListener('error', () => {});
}

elements.btnConnect.addEventListener('click', () => {
  const username = elements.tiktokUser.value.trim().replace(/^@/, '');
  if (!username) {
    showToast('Digite o @username da LIVE.');
    elements.tiktokUser.focus();
    return;
  }
  sendCommand({ type: 'connect', username });
});

elements.btnDisconnect.addEventListener('click', () => {
  sendCommand({ type: 'disconnect' });
});

elements.reset.addEventListener('click', () => {
  if (window.confirm('Zerar o placar compartilhado desta sessão para todos os painéis?')) {
    sendCommand({ type: 'reset' });
  }
});

elements.btnAuth.addEventListener('click', () => {
  const token = elements.adminToken.value;
  if (!token) {
    showToast('Digite o token de administrador.');
    return;
  }
  authenticate(token);
});

elements.adminToken.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') elements.btnAuth.click();
});

elements.tiktokUser.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') elements.btnConnect.click();
});

document.querySelectorAll('[data-gift]').forEach((button) => {
  button.addEventListener('click', () => {
    sendCommand({ type: 'simulate', giftKey: button.dataset.gift });
  });
});

render();
setConnectionStatus(connection, true);
connectWebSocket();
