import { randomUUID } from 'node:crypto';

const MAX_ACTIVITY_ITEMS = 100;
const MAX_PROCESSED_EVENT_IDS = 5_000;
const CANDIDATE_IDS = new Set(['A', 'B']);

function isoNow(now) {
  return new Date(now()).toISOString();
}

function finiteInteger(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, Number.MAX_SAFE_INTEGER);
}

function safeAdd(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, finiteInteger(left) + finiteInteger(right));
}

function cleanText(value, maxLength = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanSession(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    id: cleanText(session.id, 200) || randomUUID(),
    kind: session.kind === 'demo' ? 'demo' : 'live',
    username: cleanText(session.username, 64) || null,
    roomId: cleanText(session.roomId, 100) || null,
    startedAt: cleanText(session.startedAt, 40) || new Date().toISOString(),
    endedAt: cleanText(session.endedAt, 40) || null,
    lastResetAt: cleanText(session.lastResetAt, 40) || null,
  };
}

function cleanActivity(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ACTIVITY_ITEMS).map((item) => ({
    id: cleanText(item?.id, 200) || randomUUID(),
    at: cleanText(item?.at, 40) || new Date().toISOString(),
    source: item?.source === 'simulation' ? 'simulation' : 'tiktok',
    recognized: Boolean(item?.recognized),
    candidateId: CANDIDATE_IDS.has(item?.candidateId) ? item.candidateId : null,
    giftName: cleanText(item?.giftName) || 'Presente desconhecido',
    emoji: cleanText(item?.emoji, 16) || '🎁',
    points: finiteInteger(item?.points),
    pointsPerUnit: finiteInteger(item?.pointsPerUnit),
    repeatCount: Math.max(1, finiteInteger(item?.repeatCount, 1)),
    diamondCount: finiteInteger(item?.diamondCount),
    username: cleanText(item?.username, 80),
    nickname: cleanText(item?.nickname, 100),
  }));
}

function initialData(savedState) {
  const saved = savedState && typeof savedState === 'object' ? savedState : {};
  const scores = saved.scores && typeof saved.scores === 'object' ? saved.scores : {};

  return {
    schemaVersion: 1,
    revision: finiteInteger(saved.revision),
    session: cleanSession(saved.session),
    scores: {
      A: finiteInteger(scores.A),
      B: finiteInteger(scores.B),
    },
    totalGifts: finiteInteger(saved.totalGifts),
    totalEvents: finiteInteger(saved.totalEvents),
    unmappedGifts: finiteInteger(saved.unmappedGifts),
    participantKeys: Array.isArray(saved.participantKeys)
      ? saved.participantKeys.map((item) => cleanText(item, 180)).filter(Boolean)
      : [],
    processedEventIds: Array.isArray(saved.processedEventIds)
      ? saved.processedEventIds
          .slice(-MAX_PROCESSED_EVENT_IDS)
          .map((item) => cleanText(item, 220))
          .filter(Boolean)
      : [],
    activity: cleanActivity(saved.activity),
    updatedAt: cleanText(saved.updatedAt, 40) || null,
  };
}

export class VoteStore {
  constructor({ savedState = null, now = Date.now, onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.data = initialData(savedState);
    this.participants = new Set(this.data.participantKeys);
    this.processedEventIds = new Set(this.data.processedEventIds);
  }

  startLiveSession({ username, roomId }) {
    const cleanUsername = cleanText(username, 64).toLowerCase();
    const cleanRoomId = cleanText(String(roomId ?? ''), 100);
    if (!cleanUsername || !cleanRoomId) {
      throw new Error('Não foi possível identificar a sala da LIVE.');
    }

    const current = this.data.session;
    if (
      current?.kind === 'live' &&
      current.username?.toLowerCase() === cleanUsername &&
      current.roomId === cleanRoomId
    ) {
      if (current.endedAt) {
        current.endedAt = null;
        this.touch();
      }
      return false;
    }

    this.replaceWithEmptySession({
      id: `${cleanUsername}:${cleanRoomId}:${randomUUID()}`,
      kind: 'live',
      username: cleanUsername,
      roomId: cleanRoomId,
      startedAt: isoNow(this.now),
      endedAt: null,
      lastResetAt: null,
    });
    return true;
  }

  ensureDemoSession() {
    if (this.data.session) return false;
    this.replaceWithEmptySession({
      id: `demo:${randomUUID()}`,
      kind: 'demo',
      username: null,
      roomId: null,
      startedAt: isoNow(this.now),
      endedAt: null,
      lastResetAt: null,
    });
    return true;
  }

  replaceWithEmptySession(session) {
    this.data.session = session;
    this.data.scores = { A: 0, B: 0 };
    this.data.totalGifts = 0;
    this.data.totalEvents = 0;
    this.data.unmappedGifts = 0;
    this.data.activity = [];
    this.participants.clear();
    this.processedEventIds.clear();
    this.touch();
  }

  markSessionEnded() {
    if (!this.data.session || this.data.session.endedAt) return false;
    this.data.session.endedAt = isoNow(this.now);
    this.touch();
    return true;
  }

  reset() {
    const timestamp = isoNow(this.now);
    if (!this.data.session) {
      this.ensureDemoSession();
    }

    this.data.scores = { A: 0, B: 0 };
    this.data.totalGifts = 0;
    this.data.totalEvents = 0;
    this.data.unmappedGifts = 0;
    this.data.activity = [];
    this.data.session.lastResetAt = timestamp;
    this.participants.clear();
    this.processedEventIds.clear();
    this.touch();
  }

  recordGift(gift) {
    const eventId = cleanText(gift?.eventId, 220);
    if (eventId && this.processedEventIds.has(eventId)) {
      return { duplicate: true, activity: null };
    }

    if (eventId) {
      this.processedEventIds.add(eventId);
      while (this.processedEventIds.size > MAX_PROCESSED_EVENT_IDS) {
        this.processedEventIds.delete(this.processedEventIds.values().next().value);
      }
    }

    const repeatCount = Math.max(1, Math.min(100_000, finiteInteger(gift?.repeatCount, 1)));
    const pointsPerUnit = finiteInteger(gift?.pointsPerUnit);
    const candidateId = CANDIDATE_IDS.has(gift?.candidateId) ? gift.candidateId : null;
    const points = candidateId
      ? Math.min(Number.MAX_SAFE_INTEGER, pointsPerUnit * repeatCount)
      : 0;

    this.data.totalGifts = safeAdd(this.data.totalGifts, repeatCount);
    this.data.totalEvents = safeAdd(this.data.totalEvents, 1);

    if (candidateId) {
      this.data.scores[candidateId] = safeAdd(this.data.scores[candidateId], points);
    } else {
      this.data.unmappedGifts = safeAdd(this.data.unmappedGifts, repeatCount);
    }

    const participantKey = this.participantKey(gift);
    if (participantKey) this.participants.add(participantKey);

    const activity = {
      id: eventId || randomUUID(),
      at: isoNow(this.now),
      source: gift?.source === 'simulation' ? 'simulation' : 'tiktok',
      recognized: Boolean(candidateId),
      candidateId,
      giftName: cleanText(gift?.giftName) || 'Presente desconhecido',
      emoji: cleanText(gift?.emoji, 16) || '🎁',
      points,
      pointsPerUnit,
      repeatCount,
      diamondCount: finiteInteger(gift?.diamondCount),
      username: cleanText(gift?.username, 80),
      nickname: cleanText(gift?.nickname, 100),
    };

    this.data.activity.unshift(activity);
    this.data.activity = this.data.activity.slice(0, MAX_ACTIVITY_ITEMS);
    this.touch();
    return { duplicate: false, activity };
  }

  participantKey(gift) {
    const userId = cleanText(gift?.userId, 100);
    if (userId) return `id:${userId}`;
    const username = cleanText(gift?.username, 80).toLowerCase();
    if (username) return `user:${username}`;
    if (gift?.source === 'simulation') return 'simulation:panel';
    return '';
  }

  touch() {
    this.data.revision = safeAdd(this.data.revision, 1);
    this.data.updatedAt = isoNow(this.now);
    this.onChange(this.serialize());
  }

  snapshot() {
    const scores = { ...this.data.scores };
    return {
      revision: this.data.revision,
      session: this.data.session ? { ...this.data.session } : null,
      scores,
      totalPoints: safeAdd(scores.A, scores.B),
      totalGifts: this.data.totalGifts,
      totalEvents: this.data.totalEvents,
      totalParticipants: this.participants.size,
      unmappedGifts: this.data.unmappedGifts,
      activity: this.data.activity.slice(0, 20).map((item) => ({ ...item })),
      updatedAt: this.data.updatedAt,
    };
  }

  serialize() {
    return {
      schemaVersion: 1,
      revision: this.data.revision,
      session: this.data.session ? { ...this.data.session } : null,
      scores: { ...this.data.scores },
      totalGifts: this.data.totalGifts,
      totalEvents: this.data.totalEvents,
      unmappedGifts: this.data.unmappedGifts,
      participantKeys: [...this.participants],
      processedEventIds: [...this.processedEventIds],
      activity: this.data.activity.map((item) => ({ ...item })),
      updatedAt: this.data.updatedAt,
    };
  }
}
