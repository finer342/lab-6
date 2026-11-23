// Isomorphic simulation and binary protocol constants shared between server and client.
// Strictly free of DOM and Node.js runtime dependencies.

export const PROTOCOL_VERSION = 1 as const;

export const TICK_RATE = 30;
export const FIXED_DT = 1 / TICK_RATE;
export const TICK_INTERVAL_MS = 1000 / TICK_RATE;

export const MAX_PLAYERS_PER_ROOM = 4;

export const WORLD_WIDTH = 1000;
export const WORLD_HEIGHT = 680;

export const SHIP_RADIUS = 16;
export const BULLET_RADIUS = 4;

export const SHIP_THRUST = 420;       // px / s^2
export const SHIP_TURN_SPEED = 4.2;   // rad / s
export const SHIP_DRAG = 1.65;        // linear damping (1 / s)
export const SHIP_MAX_SPEED = 460;    // px / s

export const BULLET_SPEED = 680;      // px / s
export const BULLET_TTL = 1.45;       // seconds
export const FIRE_COOLDOWN = 0.24;    // seconds
export const RESPAWN_TIME = 2.0;      // seconds

export const MAX_HP = 100;
export const BULLET_DAMAGE = 25;

// Netcode tuning parameters
export const INTERPOLATION_DELAY_MS = 100;
export const RECONCILIATION_SMOOTH_MS = 100;

// Binary packet opcodes
export const MSG_TYPE = {
  INPUT: 0x01,
  SNAPSHOT: 0x02,
  PING: 0x03,
  PONG: 0x04
} as const;

// Bitflags for compact 1-byte input encoding
export const INPUT_FLAGS = {
  THRUST: 1 << 0,
  LEFT: 1 << 1,
  RIGHT: 1 << 2,
  FIRE: 1 << 3
} as const;

// Bitflags for compact 1-byte player state encoding
export const PLAYER_FLAGS = {
  RESPAWNING: 1 << 0,
  THRUSTING: 1 << 1
} as const;

export const SHIP_COLORS: readonly string[] = [
  '#38bdf8', // Slot 0: Sky Blue
  '#fb7185', // Slot 1: Coral Rose
  '#34d399', // Slot 2: Emerald
  '#fbbf24'  // Slot 3: Amber
];
