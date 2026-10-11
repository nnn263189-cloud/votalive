import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ControlEvent, WebcastEvent } from 'tiktok-live-connector';
import { connectorErrorMessage, LiveManager, normalizeUsername } from '../src/live-manager.js';

class FakeConnection extends EventEmitter {
  constructor({ roomId = 'room-1', error = null } = {}) {
    super();
    this.roomId = roomId;
    this.error = error;
    this.disconnected = false;
  }

  async connect() {
    if (this.error) throw this.error;
    const state = { roomId: this.roomId };
    this.emit(ControlEvent.CONNECTED, state);
    return state;
  }

  async disconnect() {
    this.disconnected = true;
  }
}

const quietLogger = { log() {}, warn() {}, error() {} };

test('valida e limpa o username', () => {
  assert.equal(normalizeUsername(' @nome.live '), 'nome.live');
  assert.throws(() => normalizeUsername('nome com espaço'), /Username inválido/);
  assert.throws(() => normalizeUsername(''), /Informe/);
});

test('extrai a mensagem do formato de erro do conector 2.5.0', () => {
  assert.equal(connectorErrorMessage({ info: 'falhou', exception: new Error('detalhe') }), 'detalhe');
  assert.equal(connectorErrorMessage({ message: 'offline' }), 'offline');
});

test('conecta, encaminha presentes e informa a sala', async () => {
  const fake = new FakeConnection({ roomId: 'abc' });
  const statuses = [];
  const connected = [];
  const gifts = [];
  const manager = new LiveManager({
    connectionFactory: () => fake,
    onStatus: (status) => statuses.push(status),
    onConnected: (event) => connected.push(event),
    onGift: (gift) => gifts.push(gift),
    logger: quietLogger,
  });

  await manager.connect('@criador');
  fake.emit(WebcastEvent.GIFT, { giftId: '1' });

  assert.equal(manager.getStatus().phase, 'connected');
  assert.equal(manager.getStatus().roomId, 'abc');
  assert.equal(connected.length, 1);
  assert.deepEqual(gifts, [{ giftId: '1' }]);
  assert.ok(statuses.some((status) => status.phase === 'connecting'));
  assert.ok(statuses.some((status) => status.phase === 'connected'));

  await manager.close();
  assert.equal(fake.disconnected, true);
});

test('expõe erro inicial e permite uma nova tentativa pelo painel', async () => {
  const warnings = [];
  const manager = new LiveManager({
    connectionFactory: () => new FakeConnection({ error: new Error('LIVE offline') }),
    onConnectorError: (event) => warnings.push(event.message),
    logger: quietLogger,
  });

  await manager.connect('criador');
  assert.equal(manager.getStatus().phase, 'error');
  assert.match(manager.getStatus().message, /offline/);
  assert.deepEqual(warnings, ['LIVE offline']);
});

test('preserva o resultado e marca status quando a LIVE termina', async () => {
  const fake = new FakeConnection();
  let ended = 0;
  const manager = new LiveManager({
    connectionFactory: () => fake,
    onStreamEnd: () => { ended += 1; },
    logger: quietLogger,
  });

  await manager.connect('criador');
  fake.emit(WebcastEvent.STREAM_END, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ended, 1);
  assert.equal(manager.getStatus().phase, 'ended');
  assert.match(manager.getStatus().message, /preservado/);
});
