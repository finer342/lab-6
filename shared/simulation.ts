// Deterministic fixed-dt game simulation shared identically between server and client.
// Uses readonly Vec2, branded IDs/ticks/seqs, and seeded PRNG (no Math.random() or Date.now()).

import {
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SHIP_RADIUS,
  BULLET_RADIUS,
  SHIP_THRUST,
  SHIP_TURN_SPEED,
  SHIP_DRAG,
  SHIP_MAX_SPEED,
  BULLET_SPEED,
  BULLET_TTL,
  FIRE_COOLDOWN,
  RESPAWN_TIME,
  MAX_HP,
  BULLET_DAMAGE
} from './constants.js';
import {
  Vec2,
  vec2,
  ZERO_VEC2,
  addVec2,
  scaleVec2,
  clampVec2Length,
  PlayerId,
  SlotIndex,
  Seed,
  Obstacle,
  ShipState,
  BulletState,
  WorldState,
  SimulationOptions,
  WorldEvent,
  toObstacleId,
  toTickNumber,
  toInputSeq,
  toClientBulletSeq,
  toBulletId,
  nextTick,
  nextClientBulletSeq
} from './types.js';
import { InputPacket } from './schemas.js';
import { createSeededRng } from './prng.js';

interface SpawnPoint {
  readonly position: Vec2;
  readonly angle: number;
}

const SPAWN_POINTS: readonly SpawnPoint[] = [
  { position: vec2(170, 180), angle: 0.25 },
  { position: vec2(830, 500), angle: -Math.PI + 0.25 },
  { position: vec2(830, 180), angle: Math.PI - 0.25 },
  { position: vec2(170, 500), angle: -0.25 }
];

function getSpawnPoint(slotIndex: SlotIndex): SpawnPoint {
  const index = Math.abs(slotIndex) % SPAWN_POINTS.length;
  return SPAWN_POINTS[index] ?? { position: vec2(170, 180), angle: 0 };
}

export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function generateArenaObstacles(seed: Seed): readonly Obstacle[] {
  const rng = createSeededRng(seed);
  const obstacles: Obstacle[] = [];
  const count = 5;

  for (let i = 0; i < count; i++) {
    let attempts = 0;
    while (attempts < 40) {
      attempts++;
      const radius = Math.round(rng.nextRange(28, 48));
      const candidate = vec2(
        Math.round(rng.nextRange(230, WORLD_WIDTH - 230)),
        Math.round(rng.nextRange(120, WORLD_HEIGHT - 120))
      );

      const clearOfSpawns = SPAWN_POINTS.every((sp) => {
        const dx = sp.position.x - candidate.x;
        const dy = sp.position.y - candidate.y;
        return Math.hypot(dx, dy) > radius + 115;
      });

      const clearOfOthers = obstacles.every((obs) => {
        const dx = obs.position.x - candidate.x;
        const dy = obs.position.y - candidate.y;
        return Math.hypot(dx, dy) > obs.radius + radius + 55;
      });

      if (clearOfSpawns && clearOfOthers) {
        obstacles.push({
          id: toObstacleId(i + 1),
          position: candidate,
          radius
        });
        break;
      }
    }
  }

  return obstacles;
}

export function createInitialWorldState(seed: Seed): WorldState {
  const rng = createSeededRng(seed);
  const obstacles = generateArenaObstacles(seed);
  return {
    tick: toTickNumber(0),
    seed,
    rngState: rng.getState(),
    players: new Map<PlayerId, ShipState>(),
    bullets: [],
    nextBulletId: 1,
    obstacles
  };
}

export function createPlayerEntity(id: PlayerId, slotIndex: SlotIndex, name = 'Pilot'): ShipState {
  const spawn = getSpawnPoint(slotIndex);
  return {
    id,
    slotIndex,
    name,
    position: spawn.position,
    velocity: ZERO_VEC2,
    angle: spawn.angle,
    hp: MAX_HP,
    score: 0,
    thrusting: false,
    fireCooldown: 0,
    respawnTimer: 0,
    lastProcessedSeq: toInputSeq(0),
    nextBulletSeq: toClientBulletSeq(1)
  };
}

/**
 * Pure kinematic integration producing updated immutable Vec2 position & velocity.
 */
export function integrateKinematics(
  position: Vec2,
  velocity: Vec2,
  dt: number,
  radius: number = SHIP_RADIUS,
  options: SimulationOptions = {}
): { readonly position: Vec2; readonly velocity: Vec2 } {
  let nextX = position.x + velocity.x * dt;
  let nextY = position.y + velocity.y * dt;
  let nextVx = velocity.x;
  let nextVy = velocity.y;

  if (options.injectRandomNoise) {
    // Intentional non-determinism experiment toggle (off by default)
    nextX += (Math.random() - 0.5) * 14;
    nextY += (Math.random() - 0.5) * 14;
  }

  if (nextX < radius) {
    nextX = radius;
    if (nextVx < 0) nextVx *= -0.35;
  } else if (nextX > WORLD_WIDTH - radius) {
    nextX = WORLD_WIDTH - radius;
    if (nextVx > 0) nextVx *= -0.35;
  }

  if (nextY < radius) {
    nextY = radius;
    if (nextVy < 0) nextVy *= -0.35;
  } else if (nextY > WORLD_HEIGHT - radius) {
    nextY = WORLD_HEIGHT - radius;
    if (nextVy > 0) nextVy *= -0.35;
  }

  return {
    position: vec2(nextX, nextY),
    velocity: vec2(nextVx, nextVy)
  };
}

export function resolveObstacleCollisions(
  position: Vec2,
  velocity: Vec2,
  obstacles: readonly Obstacle[]
): { readonly position: Vec2; readonly velocity: Vec2 } {
  let px = position.x;
  let py = position.y;
  let vx = velocity.x;
  let vy = velocity.y;

  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i];
    if (!obs) continue;

    const dx = px - obs.position.x;
    const dy = py - obs.position.y;
    const minDist = SHIP_RADIUS + obs.radius;
    const distSq = dx * dx + dy * dy;

    if (distSq < minDist * minDist) {
      const dist = Math.sqrt(distSq) || 0.001;
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minDist - dist;

      px += nx * overlap;
      py += ny * overlap;

      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        vx -= 1.25 * vn * nx;
        vy -= 1.25 * vn * ny;
      }
    }
  }

  return {
    position: vec2(px, py),
    velocity: vec2(vx, vy)
  };
}

export interface SpawnedBulletDraft {
  readonly ownerId: PlayerId;
  readonly ownerSlot: SlotIndex;
  readonly clientBulletSeq: ReturnType<typeof toClientBulletSeq>;
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly ttl: number;
}

export function stepShip(
  ship: ShipState,
  input: Pick<InputPacket, 'thrust' | 'left' | 'right' | 'fire'> | null | undefined,
  dt: number = FIXED_DT,
  obstacles: readonly Obstacle[] = [],
  options: SimulationOptions = {}
): { readonly spawnedBullet: SpawnedBulletDraft | null } {
  ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);

  if (ship.respawnTimer > 0) {
    ship.respawnTimer = Math.max(0, ship.respawnTimer - dt);
    ship.thrusting = false;
    if (ship.respawnTimer === 0) {
      const spawn = getSpawnPoint(ship.slotIndex);
      ship.position = spawn.position;
      ship.velocity = ZERO_VEC2;
      ship.angle = spawn.angle;
      ship.hp = MAX_HP;
    }
    return { spawnedBullet: null };
  }

  const safeInput = input ?? { thrust: false, left: false, right: false, fire: false };
  const turnDir = (safeInput.right ? 1 : 0) - (safeInput.left ? 1 : 0);

  if (turnDir !== 0) {
    ship.angle = normalizeAngle(ship.angle + turnDir * SHIP_TURN_SPEED * dt);
  }

  ship.thrusting = safeInput.thrust;
  let vel = ship.velocity;

  if (ship.thrusting) {
    const accel = vec2(
      Math.cos(ship.angle) * SHIP_THRUST * dt,
      Math.sin(ship.angle) * SHIP_THRUST * dt
    );
    vel = addVec2(vel, accel);
  }

  const damping = Math.max(0, 1 - SHIP_DRAG * dt);
  vel = clampVec2Length(scaleVec2(vel, damping), SHIP_MAX_SPEED);

  const integrated = integrateKinematics(ship.position, vel, dt, SHIP_RADIUS, options);
  const collided = resolveObstacleCollisions(integrated.position, integrated.velocity, obstacles);

  ship.position = collided.position;
  ship.velocity = collided.velocity;

  let spawnedBullet: SpawnedBulletDraft | null = null;
  if (safeInput.fire && ship.fireCooldown <= 0) {
    ship.fireCooldown = FIRE_COOLDOWN;
    const seq = ship.nextBulletSeq;
    ship.nextBulletSeq = nextClientBulletSeq(seq);

    const cos = Math.cos(ship.angle);
    const sin = Math.sin(ship.angle);

    spawnedBullet = {
      ownerId: ship.id,
      ownerSlot: ship.slotIndex,
      clientBulletSeq: seq,
      position: vec2(
        ship.position.x + cos * (SHIP_RADIUS + 6),
        ship.position.y + sin * (SHIP_RADIUS + 6)
      ),
      velocity: vec2(
        ship.velocity.x * 0.25 + cos * BULLET_SPEED,
        ship.velocity.y * 0.25 + sin * BULLET_SPEED
      ),
      ttl: BULLET_TTL
    };
  }

  return { spawnedBullet };
}

export function stepWorld(
  world: WorldState,
  inputsByPlayerId: ReadonlyMap<PlayerId, InputPacket> | null,
  dt: number = FIXED_DT,
  options: SimulationOptions = {}
): readonly WorldEvent[] {
  world.tick = nextTick(world.tick);
  const events: WorldEvent[] = [];

  for (const [playerId, ship] of world.players.entries()) {
    const input = inputsByPlayerId?.get(playerId);
    if (input) {
      ship.lastProcessedSeq = input.seq;
    }

    const { spawnedBullet } = stepShip(ship, input, dt, world.obstacles, options);
    if (spawnedBullet) {
      const bulletId = toBulletId(world.nextBulletId++);
      if (world.nextBulletId > 65530) {
        world.nextBulletId = 1;
      }
      world.bullets.push({
        id: bulletId,
        ...spawnedBullet
      });
    }
  }

  const survivingBullets: BulletState[] = [];
  for (let i = 0; i < world.bullets.length; i++) {
    const b = world.bullets[i];
    if (!b) continue;

    b.position = addVec2(b.position, scaleVec2(b.velocity, dt));
    b.ttl -= dt;

    if (
      b.ttl <= 0 ||
      b.position.x < 0 ||
      b.position.x > WORLD_WIDTH ||
      b.position.y < 0 ||
      b.position.y > WORLD_HEIGHT
    ) {
      continue;
    }

    let hitObstacle = false;
    for (let j = 0; j < world.obstacles.length; j++) {
      const obs = world.obstacles[j];
      if (!obs) continue;
      const dx = b.position.x - obs.position.x;
      const dy = b.position.y - obs.position.y;
      const hitDist = obs.radius + BULLET_RADIUS;
      if (dx * dx + dy * dy <= hitDist * hitDist) {
        hitObstacle = true;
        break;
      }
    }
    if (hitObstacle) continue;

    let hitShip = false;
    for (const ship of world.players.values()) {
      if (ship.id === b.ownerId || ship.respawnTimer > 0) continue;
      const dx = b.position.x - ship.position.x;
      const dy = b.position.y - ship.position.y;
      const hitDist = SHIP_RADIUS + BULLET_RADIUS;
      if (dx * dx + dy * dy <= hitDist * hitDist) {
        hitShip = true;
        ship.hp = Math.max(0, ship.hp - BULLET_DAMAGE);
        if (ship.hp === 0) {
          ship.respawnTimer = RESPAWN_TIME;
          ship.velocity = ZERO_VEC2;
          const shooter = world.players.get(b.ownerId);
          if (shooter) {
            shooter.score += 1;
          }
          events.push({
            kind: 'frag',
            killerId: b.ownerId,
            victimId: ship.id
          });
        }
        break;
      }
    }

    if (!hitShip) {
      survivingBullets.push(b);
    }
  }

  world.bullets = survivingBullets;
  return events;
}
