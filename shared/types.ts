// Core domain types: readonly Vec2, nominal Branded types for IDs/ticks/seqs,
// generic RingBuffer & Result types, and exhaustive never helper.

declare const __brand: unique symbol;

export type Brand<T, TBrand extends string> = T & {
  readonly [__brand]: TBrand;
};

// Nominal branded primitives: prevents accidentally swapping IDs, ticks, or sequence numbers.
export type PlayerId = Brand<string, 'PlayerId'>;
export type RoomId = Brand<string, 'RoomId'>;
export type BulletId = Brand<number, 'BulletId'>;
export type ObstacleId = Brand<number, 'ObstacleId'>;
export type TickNumber = Brand<number, 'TickNumber'>;
export type InputSeq = Brand<number, 'InputSeq'>;
export type ClientBulletSeq = Brand<number, 'ClientBulletSeq'>;
export type SlotIndex = Brand<number, 'SlotIndex'>;
export type Seed = Brand<number, 'Seed'>;

function attachBrand<T, TBrand extends string>(value: T): Brand<T, TBrand> {
  // Cast #1 (of 3): Attaches a compile-time nominal brand tag to a runtime primitive without altering its value.
  return value as Brand<T, TBrand>;
}

export const toPlayerId = (raw: string): PlayerId => attachBrand<string, 'PlayerId'>(raw);
export const toRoomId = (raw: string): RoomId => attachBrand<string, 'RoomId'>(raw);
export const toBulletId = (raw: number): BulletId => attachBrand<number, 'BulletId'>(raw >>> 0);
export const toObstacleId = (raw: number): ObstacleId => attachBrand<number, 'ObstacleId'>(raw >>> 0);
export const toTickNumber = (raw: number): TickNumber => attachBrand<number, 'TickNumber'>(raw >>> 0);
export const toInputSeq = (raw: number): InputSeq => attachBrand<number, 'InputSeq'>(raw >>> 0);
export const toClientBulletSeq = (raw: number): ClientBulletSeq => attachBrand<number, 'ClientBulletSeq'>(raw >>> 0);
export const toSlotIndex = (raw: number): SlotIndex => attachBrand<number, 'SlotIndex'>(raw >>> 0);
export const toSeed = (raw: number): Seed => attachBrand<number, 'Seed'>((raw >>> 0) || 1);

export const nextTick = (tick: TickNumber): TickNumber => toTickNumber(tick + 1);
export const nextInputSeq = (seq: InputSeq): InputSeq => toInputSeq(seq + 1);
export const nextClientBulletSeq = (seq: ClientBulletSeq): ClientBulletSeq => toClientBulletSeq(seq + 1);

/**
 * Immutable 2D vector with readonly coordinates.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const vec2 = (x: number, y: number): Vec2 => ({ x, y });
export const ZERO_VEC2: Vec2 = vec2(0, 0);

export const addVec2 = (a: Vec2, b: Vec2): Vec2 => ({
  x: a.x + b.x,
  y: a.y + b.y
});

export const subVec2 = (a: Vec2, b: Vec2): Vec2 => ({
  x: a.x - b.x,
  y: a.y - b.y
});

export const scaleVec2 = (v: Vec2, scalar: number): Vec2 => ({
  x: v.x * scalar,
  y: v.y * scalar
});

export const lengthVec2 = (v: Vec2): number => Math.hypot(v.x, v.y);

export const distanceVec2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function clampVec2Length(v: Vec2, maxLen: number): Vec2 {
  const len = lengthVec2(v);
  if (len <= maxLen || len === 0) return v;
  return scaleVec2(v, maxLen / len);
}

/**
 * Generic discriminated union for non-throwing runtime parsing/validation.
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Generic bounded ring buffer preserving chronological order.
 */
export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length;
  }

  at(index: number): T | undefined {
    return this.items[index];
  }

  first(): T | undefined {
    return this.items[0];
  }

  last(): T | undefined {
    return this.items.length > 0 ? this.items[this.items.length - 1] : undefined;
  }

  values(): readonly T[] {
    return this.items;
  }
}

/**
 * Exhaustive switch guard: causes a compile-time TypeScript error if any union variant is unhandled.
 */
export function assertNever(value: never, context = 'Unexpected discriminated variant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

export type ProtocolMode = 'binary' | 'json';

export interface Obstacle {
  readonly id: ObstacleId;
  readonly position: Vec2;
  readonly radius: number;
}

export interface ShipState {
  readonly id: PlayerId;
  readonly slotIndex: SlotIndex;
  name: string;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  hp: number;
  score: number;
  thrusting: boolean;
  fireCooldown: number;
  respawnTimer: number;
  lastProcessedSeq: InputSeq;
  nextBulletSeq: ClientBulletSeq;
}

export interface BulletState {
  readonly id: BulletId;
  readonly ownerId: PlayerId;
  readonly ownerSlot: SlotIndex;
  readonly clientBulletSeq: ClientBulletSeq;
  position: Vec2;
  velocity: Vec2;
  ttl: number;
}

export interface WorldState {
  tick: TickNumber;
  readonly seed: Seed;
  rngState: number;
  readonly players: Map<PlayerId, ShipState>;
  bullets: BulletState[];
  nextBulletId: number;
  readonly obstacles: readonly Obstacle[];
}

export interface SimulationOptions {
  readonly injectRandomNoise?: boolean;
}

export type WorldEvent =
  | {
      readonly kind: 'frag';
      readonly killerId: PlayerId;
      readonly victimId: PlayerId;
    };
