const MAX_REPEAT_COUNT = 100_000;

export const GIFT_RULES = Object.freeze({
  rose: Object.freeze({
    key: 'rose',
    votes: 10,
    candidateId: 'A',
    emoji: '🌹',
    label: 'Rosa normal',
    aliases: ['rose', 'rosa', 'rosa normal'],
  }),
  gg: Object.freeze({
    key: 'gg',
    votes: 10,
    candidateId: 'B',
    emoji: '🎮',
    label: 'GG',
    aliases: ['gg'],
  }),
  dino: Object.freeze({
    key: 'dino',
    votes: 100,
    candidateId: 'A',
    emoji: '🦖',
    label: 'Mini Dino',
    aliases: ['mini dino', 'mini dinosaur', 'minidino', 'dino'],
  }),
  bigRose: Object.freeze({
    key: 'bigRose',
    votes: 100,
    candidateId: 'B',
    emoji: '🌹',
    label: 'Rosa de 10 moedas',
    aliases: ['rosa de 10 moedas', 'rosa de 10', 'big rose', 'bigrose'],
  }),
  heart: Object.freeze({
    key: 'heart',
    votes: 1_000,
    candidateId: 'A',
    emoji: '🫶',
    label: 'Mãos em coração',
    aliases: ['maos em coracao', 'heart me', 'heartme'],
  }),
  misha: Object.freeze({
    key: 'misha',
    votes: 1_000,
    candidateId: 'B',
    emoji: '🧸',
    label: 'Urso Misha',
    aliases: ['misha', 'mishka', 'urso misha', 'misha bear', 'mishka bear'],
  }),
});

const ALIASES = new Map();
for (const rule of Object.values(GIFT_RULES)) {
  for (const alias of rule.aliases) {
    ALIASES.set(normalizeGiftName(alias), rule);
  }
}

const NORMAL_ROSE_NAMES = new Set(GIFT_RULES.rose.aliases.map(normalizeGiftName));

export function normalizeGiftName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function copyRule(rule) {
  if (!rule) return null;
  const { aliases: _aliases, ...gift } = rule;
  return { ...gift };
}

/**
 * Resolves only gifts that belong to a candidate. Unknown gifts deliberately
 * return null: diamond value by itself cannot determine a candidate safely.
 */
export function resolveGift(giftName, diamondCount = 0) {
  const normalizedName = normalizeGiftName(giftName);
  const diamonds = toNonNegativeNumber(diamondCount);

  // TikTok may call both products "Rose". The per-unit price distinguishes
  // the configured 1-coin rose from the configured 10-coin rose. repeatCount
  // is intentionally not used here: a combo of ten normal roses stays Lula.
  if (NORMAL_ROSE_NAMES.has(normalizedName)) {
    return copyRule(diamonds >= 10 ? GIFT_RULES.bigRose : GIFT_RULES.rose);
  }

  return copyRule(ALIASES.get(normalizedName));
}

export function getSimulationGift(key) {
  return copyRule(GIFT_RULES[key]);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function firstText(...values) {
  for (const item of values) {
    if (!['string', 'number', 'bigint'].includes(typeof item)) continue;
    const value = String(item).trim();
    if (value) return value.slice(0, 160);
  }
  return '';
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function toRepeatCount(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(number, MAX_REPEAT_COUNT);
}

function isRepeatFinished(value) {
  return value === true || value === 1 || value === '1';
}

/**
 * Normalizes both the v3 event shape used by tiktok-live-connector 2.5.0 and
 * legacy event shapes. Intermediate streak frames are returned as pending.
 */
export function parseGiftEvent(data = {}) {
  const details = data.gift ?? data.giftDetails ?? {};
  const extended = data.extendedGiftInfo ?? {};

  const giftId = String(firstDefined(data.giftId, details.id, extended.id, '') || '').slice(0, 80);
  const giftName = firstText(
    extended.name,
    extended.giftName,
    details.name,
    details.giftName,
    data.giftName,
  ) || (giftId ? `Presente #${giftId}` : 'Presente desconhecido');

  const diamondCount = toNonNegativeNumber(firstDefined(
    extended.diamondCount,
    extended.diamond_count,
    details.diamondCount,
    details.diamond_count,
    data.diamondCount,
    data.diamond_count,
    0,
  ));

  const giftType = Number(firstDefined(
    details.type,
    details.giftType,
    extended.type,
    extended.giftType,
    data.giftType,
    0,
  ));
  const repeatCount = toRepeatCount(firstDefined(data.repeatCount, data.comboCount, 1));

  if (giftType === 1 && !isRepeatFinished(data.repeatEnd)) {
    return {
      status: 'pending',
      giftId,
      giftName,
      repeatCount,
    };
  }

  const user = data.user ?? {};
  const userId = firstText(user.userId, user.id, data.userId);
  const username = firstText(user.uniqueId, data.uniqueId);
  const nickname = firstText(user.nickname, data.nickname);
  const messageId = firstText(
    data.common?.msgId,
    data.logId,
    data.orderId,
  );
  const roomId = firstText(data.common?.roomId);
  const resolved = resolveGift(giftName, diamondCount);

  return {
    status: 'complete',
    gift: {
      eventId: messageId ? `${roomId}:${messageId}` : '',
      giftId,
      giftName: resolved?.label ?? giftName,
      originalGiftName: giftName,
      emoji: resolved?.emoji ?? '🎁',
      pointsPerUnit: resolved?.votes ?? 0,
      candidateId: resolved?.candidateId ?? null,
      repeatCount,
      diamondCount,
      userId,
      username,
      nickname,
      source: 'tiktok',
    },
  };
}
