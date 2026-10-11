import assert from 'node:assert/strict';
import test from 'node:test';

import { VoteStore } from '../src/state-store.js';

function createStore(savedState = null) {
  let timestamp = Date.parse('2026-10-11T12:00:00.000Z');
  const changes = [];
  const store = new VoteStore({
    savedState,
    now: () => timestamp++,
    onChange: (state) => changes.push(state),
  });
  return { store, changes };
}

function rose(overrides = {}) {
  return {
    eventId: 'room:message-1',
    giftName: 'Rosa normal',
    emoji: '🌹',
    pointsPerUnit: 10,
    candidateId: 'A',
    repeatCount: 1,
    diamondCount: 1,
    userId: 'user-1',
    username: 'ana',
    nickname: 'Ana',
    source: 'tiktok',
    ...overrides,
  };
}

test('conta unidades do combo, evento final, participante e pontos separadamente', () => {
  const { store } = createStore();
  store.startLiveSession({ username: 'criador', roomId: 'room-1' });
  store.recordGift(rose({ repeatCount: 7 }));

  const state = store.snapshot();
  assert.deepEqual(state.scores, { A: 70, B: 0 });
  assert.equal(state.totalPoints, 70);
  assert.equal(state.totalGifts, 7);
  assert.equal(state.totalEvents, 1);
  assert.equal(state.totalParticipants, 1);
  assert.equal(state.activity[0].points, 70);
  assert.equal(state.activity[0].repeatCount, 7);
});

test('participantes são únicos, mesmo com vários eventos', () => {
  const { store } = createStore();
  store.startLiveSession({ username: 'criador', roomId: 'room-1' });
  store.recordGift(rose());
  store.recordGift(rose({ eventId: 'room:message-2', candidateId: 'B', username: 'ana' }));
  store.recordGift(rose({ eventId: 'room:message-3', userId: 'user-2', username: 'bia' }));

  const state = store.snapshot();
  assert.equal(state.totalGifts, 3);
  assert.equal(state.totalEvents, 3);
  assert.equal(state.totalParticipants, 2);
});

test('presente desconhecido entra nas métricas e no histórico, mas não no placar', () => {
  const { store } = createStore();
  store.startLiveSession({ username: 'criador', roomId: 'room-1' });
  store.recordGift(rose({
    eventId: 'room:unknown',
    giftName: 'Presente surpresa',
    candidateId: null,
    pointsPerUnit: 0,
    repeatCount: 4,
  }));

  const state = store.snapshot();
  assert.equal(state.totalGifts, 4);
  assert.equal(state.unmappedGifts, 4);
  assert.equal(state.totalPoints, 0);
  assert.equal(state.activity[0].recognized, false);
});

test('deduplica o mesmo evento final', () => {
  const { store } = createStore();
  store.startLiveSession({ username: 'criador', roomId: 'room-1' });
  assert.equal(store.recordGift(rose()).duplicate, false);
  assert.equal(store.recordGift(rose()).duplicate, true);
  assert.equal(store.snapshot().totalGifts, 1);
});

test('mantém a sessão ao reconectar na mesma sala e zera em uma sala nova', () => {
  const { store } = createStore();
  assert.equal(store.startLiveSession({ username: 'Criador', roomId: 'room-1' }), true);
  store.recordGift(rose());
  const firstSession = store.snapshot().session.id;

  assert.equal(store.startLiveSession({ username: 'criador', roomId: 'room-1' }), false);
  assert.equal(store.snapshot().scores.A, 10);
  assert.equal(store.snapshot().session.id, firstSession);

  assert.equal(store.startLiveSession({ username: 'criador', roomId: 'room-2' }), true);
  assert.equal(store.snapshot().scores.A, 0);
  assert.equal(store.snapshot().totalGifts, 0);
  assert.notEqual(store.snapshot().session.id, firstSession);
});

test('reset compartilhado preserva a identidade da LIVE e limpa os totais', () => {
  const { store } = createStore();
  store.startLiveSession({ username: 'criador', roomId: 'room-1' });
  store.recordGift(rose());
  const sessionId = store.snapshot().session.id;
  store.reset();

  const state = store.snapshot();
  assert.equal(state.session.id, sessionId);
  assert.ok(state.session.lastResetAt);
  assert.deepEqual(state.scores, { A: 0, B: 0 });
  assert.equal(state.totalParticipants, 0);
  assert.deepEqual(state.activity, []);
});

test('estado serializado restaura placar, participantes e deduplicação', () => {
  const first = createStore().store;
  first.startLiveSession({ username: 'criador', roomId: 'room-1' });
  first.recordGift(rose({ repeatCount: 2 }));

  const restored = createStore(first.serialize()).store;
  assert.equal(restored.snapshot().scores.A, 20);
  assert.equal(restored.snapshot().totalParticipants, 1);
  assert.equal(restored.recordGift(rose()).duplicate, true);
});

test('modo de teste cria sessão sem substituir uma sessão real existente', () => {
  const { store } = createStore();
  assert.equal(store.ensureDemoSession(), true);
  store.recordGift(rose({
    eventId: 'simulation:1',
    source: 'simulation',
    userId: '',
    username: 'teste',
  }));
  assert.equal(store.snapshot().session.kind, 'demo');
  assert.equal(store.snapshot().totalParticipants, 1);

  store.startLiveSession({ username: 'criador', roomId: 'room-1' });
  const liveSession = store.snapshot().session.id;
  assert.equal(store.ensureDemoSession(), false);
  assert.equal(store.snapshot().session.id, liveSession);
});
