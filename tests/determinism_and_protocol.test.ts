import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT, PROTOCOL_VERSION, MSG_TYPE } from '../shared/constants.js';
import {
  vec2,
  toSeed,
  toPlayerId,
  toSlotIndex,
  toInputSeq,
  toTickNumber,
  toBulletId,
  toClientBulletSeq
} from '../shared/types.js';
import { createSeededRng } from '../shared/prng.js';
import {
  createInitialWorldState,
  createPlayerEntity,
  stepWorld,
  stepShip
} from '../shared/simulation.js';
import {
  encodeInputBinary,
  decodeInputBinary,
  encodeSnapshotBinary,
  decodeSnapshotBinary,
  encodeAngleInt16,
  decodeAngleInt16,
  parseClientMessage
} from '../shared/protocol.js';
import { InputPacket } from '../shared/schemas.js';

test('Seeded PRNG produces identical sequences for identical seeds', () => {
  const rngA = createSeededRng(toSeed(98765));
  const rngB = createSeededRng(toSeed(98765));
  for (let i = 0; i < 50; i++) {
    assert.equal(rngA.next(), rngB.next());
  }
});

test('Shared TypeScript simulation preserves 100% determinism across server and client', () => {
  const worldServer = createInitialWorldState(toSeed(4242));
  const worldClient = createInitialWorldState(toSeed(4242));

  const p1 = toPlayerId('p1');
  const shipS = createPlayerEntity(p1, toSlotIndex(0), 'Alpha');
  const shipC = createPlayerEntity(p1, toSlotIndex(0), 'Alpha');
  worldServer.players.set(p1, shipS);

  for (let seq = 1; seq <= 60; seq++) {
    const input: InputPacket = {
      type: 'input',
      seq: toInputSeq(seq),
      thrust: seq % 3 !== 0,
      left: seq > 15 && seq < 35,
      right: seq >= 40,
      fire: seq === 10 || seq === 30,
      clientTimeMs: seq * 33
    };

    const map = new Map([[p1, input]]);
    stepWorld(worldServer, map, FIXED_DT);
    stepShip(shipC, input, FIXED_DT, worldClient.obstacles);
  }

  assert.equal(shipS.position.x, shipC.position.x);
  assert.equal(shipS.position.y, shipC.position.y);
  assert.equal(shipS.velocity.x, shipC.velocity.x);
  assert.equal(shipS.velocity.y, shipC.velocity.y);
  assert.equal(shipS.angle, shipC.angle);
});

test('Binary DataView codec validates length, ranges, and version byte without throwing', () => {
  const buf = encodeInputBinary({
    type: 'input',
    seq: toInputSeq(123456),
    thrust: true,
    left: false,
    right: true,
    fire: true,
    clientTimeMs: 55500
  });

  assert.equal(buf.byteLength, 11);
  const view = new DataView(buf);
  assert.equal(view.getUint8(0), PROTOCOL_VERSION);
  assert.equal(view.getUint8(1), MSG_TYPE.INPUT);

  const valid = decodeInputBinary(buf);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.seq, 123456);
    assert.equal(valid.value.thrust, true);
  }

  // Corrupt version byte -> returns { ok: false } instead of throwing
  const badVersion = buf.slice(0);
  new DataView(badVersion).setUint8(0, 99);
  const badRes = decodeInputBinary(badVersion);
  assert.equal(badRes.ok, false);

  // Truncated buffer -> returns { ok: false }
  const shortRes = decodeInputBinary(buf.slice(0, 5));
  assert.equal(shortRes.ok, false);
});

test('parseClientMessage handles malformed JSON safely without throwing', () => {
  const brokenJson = parseClientMessage('{not-valid-json');
  assert.equal(brokenJson.ok, false);

  const wrongSchema = parseClientMessage(JSON.stringify({ type: 'input', seq: -5 }));
  assert.equal(wrongSchema.ok, false);

  const validChat = parseClientMessage(JSON.stringify({ type: 'chat', text: 'Hello TS!' }));
  assert.equal(validChat.ok, true);
});

test('Binary Snapshot encodes and decodes discriminated entities (`kind`: ship | bullet)', () => {
  const origAngle = -1.8742;
  const packed = encodeAngleInt16(origAngle);
  const unpacked = decodeAngleInt16(packed);
  assert.ok(Math.abs(origAngle - unpacked) < 0.0002);

  const snapBuf = encodeSnapshotBinary({
    type: 'snapshot',
    serverTick: toTickNumber(900),
    serverTimestamp: 12345.5,
    entities: [
      {
        kind: 'ship',
        slotIndex: toSlotIndex(0),
        lastProcessedSeq: toInputSeq(88),
        position: vec2(345.6, 512.3),
        velocity: vec2(120.4, -45.2),
        angle: origAngle,
        hp: 75,
        score: 2,
        isRespawning: false,
        thrusting: true
      },
      {
        kind: 'bullet',
        id: toBulletId(14),
        ownerSlot: toSlotIndex(0),
        clientBulletSeq: toClientBulletSeq(5),
        position: vec2(400.1, 500.9),
        velocity: vec2(600.0, -120.0)
      }
    ]
  });

  assert.equal(snapBuf.byteLength, 46);
  const decoded = decodeSnapshotBinary(snapBuf);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.value.entities.length, 2);
    const e0 = decoded.value.entities[0];
    const e1 = decoded.value.entities[1];
    assert.equal(e0?.kind, 'ship');
    assert.equal(e1?.kind, 'bullet');
  }
});
