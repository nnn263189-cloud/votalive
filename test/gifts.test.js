import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GIFT_RULES,
  getSimulationGift,
  normalizeGiftName,
  parseGiftEvent,
  resolveGift,
} from '../src/gifts.js';

test('preserva as seis regras de pontuação', () => {
  assert.deepEqual(resolveGift('Rose', 1), {
    key: 'rose', votes: 10, candidateId: 'A', emoji: '🌹', label: 'Rosa normal',
  });
  assert.equal(resolveGift('GG', 1).candidateId, 'B');
  assert.equal(resolveGift('Mini Dino', 10).votes, 100);
  assert.equal(resolveGift('Rosa de 10 moedas', 10).candidateId, 'B');
  assert.equal(resolveGift('Mãos em coração', 100).candidateId, 'A');
  assert.equal(resolveGift('Mishka Bear', 100).candidateId, 'B');
});

test('normaliza acentos, pontuação e espaços sem fazer match parcial perigoso', () => {
  assert.equal(normalizeGiftName('  MÃOS--em   Coração! '), 'maos em coracao');
  assert.equal(resolveGift('MÃOS--em   Coração!', 100).key, 'heart');
  assert.equal(resolveGift('g', 1), null);
  assert.equal(resolveGift('urso qualquer', 100), null);
});

test('distingue rosa por preço unitário, não pelo tamanho do combo', () => {
  assert.equal(resolveGift('Rose', 1).key, 'rose');
  assert.equal(resolveGift('Rose', 10).key, 'bigRose');

  const combo = parseGiftEvent({
    giftId: '5655',
    gift: { name: 'Rose', diamondCount: 1, type: 1 },
    repeatCount: 10,
    repeatEnd: 1,
  });
  assert.equal(combo.gift.candidateId, 'A');
  assert.equal(combo.gift.repeatCount, 10);
  assert.equal(combo.gift.pointsPerUnit, 10);
});

test('ignora atualizações intermediárias de streak e processa apenas o final', () => {
  const baseEvent = {
    giftId: '5655',
    gift: { name: 'Rose', diamondCount: 1, type: 1 },
    repeatCount: 7,
  };
  assert.deepEqual(parseGiftEvent({ ...baseEvent, repeatEnd: 0 }), {
    status: 'pending', giftId: '5655', giftName: 'Rose', repeatCount: 7,
  });
  assert.equal(parseGiftEvent({ ...baseEvent, repeatEnd: 1 }).status, 'complete');
});

test('lê o formato v3 do conector 2.5.0', () => {
  const parsed = parseGiftEvent({
    common: { msgId: '123', roomId: '456' },
    giftId: '999',
    gift: { name: 'Mini Dinosaur', diamondCount: 10, type: 0 },
    repeatCount: 3,
    repeatEnd: 0,
    user: { id: '42', uniqueId: 'ana.live', nickname: 'Ana' },
  });

  assert.equal(parsed.status, 'complete');
  assert.deepEqual(parsed.gift, {
    eventId: '456:123',
    giftId: '999',
    giftName: 'Mini Dino',
    originalGiftName: 'Mini Dinosaur',
    emoji: '🦖',
    pointsPerUnit: 100,
    candidateId: 'A',
    repeatCount: 3,
    diamondCount: 10,
    userId: '42',
    username: 'ana.live',
    nickname: 'Ana',
    source: 'tiktok',
  });
});

test('mantém compatibilidade com o formato legado e não pontua desconhecidos', () => {
  const known = parseGiftEvent({
    giftDetails: { giftName: 'GG', diamondCount: 1, giftType: 0 },
    repeatCount: 2,
    user: { userId: '1', uniqueId: 'bia' },
  });
  assert.equal(known.gift.candidateId, 'B');
  assert.equal(known.gift.repeatCount, 2);

  const unknown = parseGiftEvent({
    giftId: '777',
    gift: { name: 'Outro presente', diamondCount: 5_000, type: 0 },
    repeatCount: 1,
  });
  assert.equal(unknown.gift.candidateId, null);
  assert.equal(unknown.gift.pointsPerUnit, 0);
  assert.equal(unknown.gift.giftName, 'Outro presente');
});

test('presentes de simulação vêm da mesma configuração do servidor', () => {
  assert.equal(getSimulationGift('misha').votes, GIFT_RULES.misha.votes);
  assert.equal(getSimulationGift('inexistente'), null);
});
