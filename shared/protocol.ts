// Binary (ArrayBuffer + DataView, little-endian, version byte, Int16 angle)
// and Zod-validated JSON protocol codec. Never throws on malformed network input.

import {
  PROTOCOL_VERSION,
  MSG_TYPE,
  INPUT_FLAGS,
  PLAYER_FLAGS,
  MAX_PLAYERS_PER_ROOM,
  WORLD_WIDTH,
  WORLD_HEIGHT
} from './constants.js';
import {
  ParseResult,
  ProtocolMode,
  vec2,
  toInputSeq,
  toTickNumber,
  toSlotIndex,
  toBulletId,
  toClientBulletSeq,
  assertNever
} from './types.js';
import {
  InputPacket,
  SnapshotPacket,
  PingPacket,
  PongPacket,
  ClientMessage,
  ServerMessage,
  ClientMessageSchema,
  ServerMessageSchema,
  SnapshotEntity,
  SnapshotShipEntity,
  SnapshotBulletEntity
} from './schemas.js';
import { normalizeAngle } from './simulation.js';

const INPUT_PACKET_BYTES = 11;
const PING_PACKET_BYTES = 10;
const PONG_PACKET_BYTES = 18;
const SNAPSHOT_HEADER_BYTES = 16;
const SNAPSHOT_SHIP_BYTES = 18;
const SNAPSHOT_BULLET_BYTES = 12;
const MAX_SNAPSHOT_BULLETS = 200;

export function encodeAngleInt16(radians: number): number {
  const norm = normalizeAngle(radians);
  return Math.max(-32767, Math.min(32767, Math.round((norm / Math.PI) * 32767)));
}

export function decodeAngleInt16(int16Val: number): number {
  return (int16Val / 32767) * Math.PI;
}

function clampInt16(val: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(val)));
}

/**
 * Encodes an InputPacket into an 11-byte little-endian ArrayBuffer.
 */
export function encodeInputBinary(input: InputPacket): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_PACKET_BYTES);
  const view = new DataView(buffer);

  let flags = 0;
  if (input.thrust) flags |= INPUT_FLAGS.THRUST;
  if (input.left) flags |= INPUT_FLAGS.LEFT;
  if (input.right) flags |= INPUT_FLAGS.RIGHT;
  if (input.fire) flags |= INPUT_FLAGS.FIRE;

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_TYPE.INPUT);
  view.setUint32(2, input.seq >>> 0, true);
  view.setUint8(6, flags);
  view.setUint32(7, input.clientTimeMs >>> 0, true);

  return buffer;
}

/**
 * Decodes and validates an 11-byte InputPacket (checks byteLength, version, opcode, and flag range).
 */
export function decodeInputBinary(buffer: ArrayBuffer): ParseResult<InputPacket> {
  if (buffer.byteLength !== INPUT_PACKET_BYTES) {
    return {
      ok: false,
      error: `Invalid INPUT byteLength: expected ${INPUT_PACKET_BYTES}, got ${buffer.byteLength}`
    };
  }

  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${version}` };
  }

  const opcode = view.getUint8(1);
  if (opcode !== MSG_TYPE.INPUT) {
    return { ok: false, error: `Expected INPUT opcode (0x01), got 0x${opcode.toString(16)}` };
  }

  const seq = view.getUint32(2, true);
  const flags = view.getUint8(6);
  if ((flags & ~0x0f) !== 0) {
    return { ok: false, error: `Invalid input flag bits: 0x${flags.toString(16)}` };
  }

  const clientTimeMs = view.getUint32(7, true);

  return {
    ok: true,
    value: {
      type: 'input',
      seq: toInputSeq(seq),
      thrust: Boolean(flags & INPUT_FLAGS.THRUST),
      left: Boolean(flags & INPUT_FLAGS.LEFT),
      right: Boolean(flags & INPUT_FLAGS.RIGHT),
      fire: Boolean(flags & INPUT_FLAGS.FIRE),
      clientTimeMs
    }
  };
}

/**
 * Encodes a SnapshotPacket into a compact little-endian ArrayBuffer.
 */
export function encodeSnapshotBinary(snapshot: SnapshotPacket): ArrayBuffer {
  const ships: SnapshotShipEntity[] = [];
  const bullets: SnapshotBulletEntity[] = [];

  for (const entity of snapshot.entities) {
    switch (entity.kind) {
      case 'ship':
        ships.push(entity);
        break;
      case 'bullet':
        bullets.push(entity);
        break;
      default:
        return assertNever(entity);
    }
  }

  const byteLength =
    SNAPSHOT_HEADER_BYTES +
    ships.length * SNAPSHOT_SHIP_BYTES +
    bullets.length * SNAPSHOT_BULLET_BYTES;

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_TYPE.SNAPSHOT);
  view.setUint32(2, snapshot.serverTick >>> 0, true);
  view.setFloat64(6, snapshot.serverTimestamp, true);
  view.setUint8(14, ships.length);
  view.setUint8(15, bullets.length);

  let offset = SNAPSHOT_HEADER_BYTES;
  for (const p of ships) {
    let pFlags = 0;
    if (p.isRespawning) pFlags |= PLAYER_FLAGS.RESPAWNING;
    if (p.thrusting) pFlags |= PLAYER_FLAGS.THRUSTING;

    view.setUint8(offset, p.slotIndex & 0xff);
    view.setUint32(offset + 1, p.lastProcessedSeq >>> 0, true);
    view.setInt16(offset + 5, clampInt16(p.position.x * 10), true);
    view.setInt16(offset + 7, clampInt16(p.position.y * 10), true);
    view.setInt16(offset + 9, clampInt16(p.velocity.x * 10), true);
    view.setInt16(offset + 11, clampInt16(p.velocity.y * 10), true);
    view.setInt16(offset + 13, encodeAngleInt16(p.angle), true);
    view.setUint8(offset + 15, Math.max(0, Math.min(255, Math.round(p.hp))));
    view.setUint8(offset + 16, Math.max(0, Math.min(255, Math.round(p.score))));
    view.setUint8(offset + 17, pFlags);
    offset += SNAPSHOT_SHIP_BYTES;
  }

  for (const b of bullets) {
    view.setUint16(offset, b.id & 0xffff, true);
    view.setUint8(offset + 2, b.ownerSlot & 0xff);
    view.setUint8(offset + 3, b.clientBulletSeq & 0xff);
    view.setInt16(offset + 4, clampInt16(b.position.x * 10), true);
    view.setInt16(offset + 6, clampInt16(b.position.y * 10), true);
    view.setInt16(offset + 8, clampInt16(b.velocity.x * 10), true);
    view.setInt16(offset + 10, clampInt16(b.velocity.y * 10), true);
    offset += SNAPSHOT_BULLET_BYTES;
  }

  return buffer;
}

/**
 * Decodes and validates a binary SnapshotPacket (checks header size, version, counts, exact byteLength, and coordinate ranges).
 */
export function decodeSnapshotBinary(buffer: ArrayBuffer): ParseResult<SnapshotPacket> {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) {
    return {
      ok: false,
      error: `Snapshot too short: ${buffer.byteLength}B < ${SNAPSHOT_HEADER_BYTES}B`
    };
  }

  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${version}` };
  }

  const opcode = view.getUint8(1);
  if (opcode !== MSG_TYPE.SNAPSHOT) {
    return { ok: false, error: `Expected SNAPSHOT opcode (0x02), got 0x${opcode.toString(16)}` };
  }

  const serverTick = view.getUint32(2, true);
  const serverTimestamp = view.getFloat64(6, true);
  if (!Number.isFinite(serverTimestamp) || serverTimestamp < 0) {
    return { ok: false, error: 'Invalid serverTimestamp in snapshot' };
  }

  const playerCount = view.getUint8(14);
  const bulletCount = view.getUint8(15);

  if (playerCount > MAX_PLAYERS_PER_ROOM) {
    return { ok: false, error: `playerCount ${playerCount} exceeds max ${MAX_PLAYERS_PER_ROOM}` };
  }
  if (bulletCount > MAX_SNAPSHOT_BULLETS) {
    return { ok: false, error: `bulletCount ${bulletCount} exceeds max ${MAX_SNAPSHOT_BULLETS}` };
  }

  const expectedLength =
    SNAPSHOT_HEADER_BYTES +
    playerCount * SNAPSHOT_SHIP_BYTES +
    bulletCount * SNAPSHOT_BULLET_BYTES;

  if (buffer.byteLength !== expectedLength) {
    return {
      ok: false,
      error: `Snapshot length mismatch: expected ${expectedLength}B, got ${buffer.byteLength}B`
    };
  }

  const entities: SnapshotEntity[] = [];
  let offset = SNAPSHOT_HEADER_BYTES;

  for (let i = 0; i < playerCount; i++) {
    const rawSlot = view.getUint8(offset);
    if (rawSlot >= MAX_PLAYERS_PER_ROOM) {
      return { ok: false, error: `Ship slotIndex ${rawSlot} out of range` };
    }

    const lastProcessedSeq = view.getUint32(offset + 1, true);
    const x = view.getInt16(offset + 5, true) / 10;
    const y = view.getInt16(offset + 7, true) / 10;
    const vx = view.getInt16(offset + 9, true) / 10;
    const vy = view.getInt16(offset + 11, true) / 10;
    const angle = decodeAngleInt16(view.getInt16(offset + 13, true));
    const hp = view.getUint8(offset + 15);
    const score = view.getUint8(offset + 16);
    const pFlags = view.getUint8(offset + 17);

    if (x < -50 || x > WORLD_WIDTH + 50 || y < -50 || y > WORLD_HEIGHT + 50) {
      return { ok: false, error: `Ship coordinates (${x}, ${y}) out of world range` };
    }

    entities.push({
      kind: 'ship',
      slotIndex: toSlotIndex(rawSlot),
      lastProcessedSeq: toInputSeq(lastProcessedSeq),
      position: vec2(x, y),
      velocity: vec2(vx, vy),
      angle,
      hp,
      score,
      isRespawning: Boolean(pFlags & PLAYER_FLAGS.RESPAWNING),
      thrusting: Boolean(pFlags & PLAYER_FLAGS.THRUSTING)
    });
    offset += SNAPSHOT_SHIP_BYTES;
  }

  for (let i = 0; i < bulletCount; i++) {
    const id = view.getUint16(offset, true);
    const ownerSlot = view.getUint8(offset + 2);
    if (ownerSlot >= MAX_PLAYERS_PER_ROOM) {
      return { ok: false, error: `Bullet ownerSlot ${ownerSlot} out of range` };
    }

    const clientBulletSeq = view.getUint8(offset + 3);
    const x = view.getInt16(offset + 4, true) / 10;
    const y = view.getInt16(offset + 6, true) / 10;
    const vx = view.getInt16(offset + 8, true) / 10;
    const vy = view.getInt16(offset + 10, true) / 10;

    entities.push({
      kind: 'bullet',
      id: toBulletId(id),
      ownerSlot: toSlotIndex(ownerSlot),
      clientBulletSeq: toClientBulletSeq(clientBulletSeq),
      position: vec2(x, y),
      velocity: vec2(vx, vy)
    });
    offset += SNAPSHOT_BULLET_BYTES;
  }

  return {
    ok: true,
    value: {
      type: 'snapshot',
      serverTick: toTickNumber(serverTick),
      serverTimestamp,
      entities
    }
  };
}

export function encodePingBinary(ping: PingPacket): ArrayBuffer {
  const buffer = new ArrayBuffer(PING_PACKET_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_TYPE.PING);
  view.setFloat64(2, ping.clientSendTime, true);
  return buffer;
}

export function decodePingBinary(buffer: ArrayBuffer): ParseResult<PingPacket> {
  if (buffer.byteLength !== PING_PACKET_BYTES) {
    return {
      ok: false,
      error: `Invalid PING byteLength: expected ${PING_PACKET_BYTES}, got ${buffer.byteLength}`
    };
  }
  const view = new DataView(buffer);
  if (view.getUint8(0) !== PROTOCOL_VERSION) {
    return { ok: false, error: 'Unsupported protocol version in PING' };
  }
  const clientSendTime = view.getFloat64(2, true);
  if (!Number.isFinite(clientSendTime) || clientSendTime < 0) {
    return { ok: false, error: 'Invalid clientSendTime in PING' };
  }
  return {
    ok: true,
    value: { type: 'ping', clientSendTime }
  };
}

export function encodePongBinary(pong: PongPacket): ArrayBuffer {
  const buffer = new ArrayBuffer(PONG_PACKET_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_TYPE.PONG);
  view.setFloat64(2, pong.clientSendTime, true);
  view.setFloat64(10, pong.serverTime, true);
  return buffer;
}

export function decodePongBinary(buffer: ArrayBuffer): ParseResult<PongPacket> {
  if (buffer.byteLength !== PONG_PACKET_BYTES) {
    return {
      ok: false,
      error: `Invalid PONG byteLength: expected ${PONG_PACKET_BYTES}, got ${buffer.byteLength}`
    };
  }
  const view = new DataView(buffer);
  if (view.getUint8(0) !== PROTOCOL_VERSION) {
    return { ok: false, error: 'Unsupported protocol version in PONG' };
  }
  const clientSendTime = view.getFloat64(2, true);
  const serverTime = view.getFloat64(10, true);
  if (!Number.isFinite(clientSendTime) || !Number.isFinite(serverTime)) {
    return { ok: false, error: 'Non-finite timestamps in PONG' };
  }
  return {
    ok: true,
    value: { type: 'pong', clientSendTime, serverTime }
  };
}

export type BinaryGamePacket = InputPacket | SnapshotPacket | PingPacket | PongPacket;

export function decodeBinaryMessage(buffer: ArrayBuffer): ParseResult<BinaryGamePacket> {
  if (buffer.byteLength < 2) {
    return { ok: false, error: 'Binary packet shorter than 2-byte header' };
  }
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported binary protocol version: ${version}` };
  }

  const opcode = view.getUint8(1);
  switch (opcode) {
    case MSG_TYPE.INPUT:
      return decodeInputBinary(buffer);
    case MSG_TYPE.SNAPSHOT:
      return decodeSnapshotBinary(buffer);
    case MSG_TYPE.PING:
      return decodePingBinary(buffer);
    case MSG_TYPE.PONG:
      return decodePongBinary(buffer);
    default:
      return { ok: false, error: `Unknown binary opcode: 0x${opcode.toString(16)}` };
  }
}

export function encodeGamePacket(packet: BinaryGamePacket, mode: ProtocolMode): ArrayBuffer | string {
  if (mode === 'json') {
    return JSON.stringify(packet);
  }
  switch (packet.type) {
    case 'input':
      return encodeInputBinary(packet);
    case 'snapshot':
      return encodeSnapshotBinary(packet);
    case 'ping':
      return encodePingBinary(packet);
    case 'pong':
      return encodePongBinary(packet);
    default:
      return assertNever(packet);
  }
}

function toArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    const copy = new Uint8Array(raw.byteLength);
    copy.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    return copy.buffer;
  }
  return null;
}

function safeJsonParse(text: string): ParseResult<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Malformed JSON';
    return { ok: false, error: `JSON parse failed: ${msg}` };
  }
}

/**
 * Parses and validates any incoming client WebSocket payload (unknown).
 * Never throws: malformed JSON or invalid binary packets return { ok: false, error }.
 */
export function parseClientMessage(raw: unknown): ParseResult<{
  readonly message: ClientMessage;
  readonly byteLength: number;
}> {
  if (typeof raw === 'string') {
    const byteLength = new TextEncoder().encode(raw).length;
    const jsonRes = safeJsonParse(raw);
    if (!jsonRes.ok) return jsonRes;

    const zodRes = ClientMessageSchema.safeParse(jsonRes.value);
    if (!zodRes.success) {
      const summary = zodRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ok: false, error: `ClientMessage Zod validation failed: ${summary}` };
    }
    return { ok: true, value: { message: zodRes.data, byteLength } };
  }

  const arrayBuffer = toArrayBuffer(raw);
  if (!arrayBuffer) {
    return { ok: false, error: 'Unsupported WebSocket frame payload type' };
  }

  const binRes = decodeBinaryMessage(arrayBuffer);
  if (!binRes.ok) return binRes;

  const pkt = binRes.value;
  if (pkt.type === 'input' || pkt.type === 'ping') {
    return {
      ok: true,
      value: { message: pkt, byteLength: arrayBuffer.byteLength }
    };
  }

  return {
    ok: false,
    error: `Client is not allowed to send '${pkt.type}' packets`
  };
}

/**
 * Parses and validates any incoming server WebSocket payload (unknown) on the client.
 */
export function parseServerMessage(raw: unknown): ParseResult<{
  readonly message: ServerMessage;
  readonly byteLength: number;
}> {
  if (typeof raw === 'string') {
    const byteLength = new TextEncoder().encode(raw).length;
    const jsonRes = safeJsonParse(raw);
    if (!jsonRes.ok) return jsonRes;

    const zodRes = ServerMessageSchema.safeParse(jsonRes.value);
    if (!zodRes.success) {
      const summary = zodRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ok: false, error: `ServerMessage Zod validation failed: ${summary}` };
    }
    return { ok: true, value: { message: zodRes.data, byteLength } };
  }

  const arrayBuffer = toArrayBuffer(raw);
  if (!arrayBuffer) {
    return { ok: false, error: 'Unsupported server frame payload type' };
  }

  const binRes = decodeBinaryMessage(arrayBuffer);
  if (!binRes.ok) return binRes;

  const pkt = binRes.value;
  if (pkt.type === 'snapshot' || pkt.type === 'pong') {
    return {
      ok: true,
      value: { message: pkt, byteLength: arrayBuffer.byteLength }
    };
  }

  return {
    ok: false,
    error: `Unexpected binary packet '${pkt.type}' from server`
  };
}
