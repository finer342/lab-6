// Framework-free HTML5 Canvas renderer under strict TypeScript.
// Uses exhaustive `switch (entity.kind)` with `assertNever` for snapshot entities.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SHIP_RADIUS,
  BULLET_RADIUS,
  SHIP_COLORS,
  MAX_HP
} from '../shared/constants.js';
import {
  Vec2,
  SlotIndex,
  Seed,
  Obstacle,
  assertNever
} from '../shared/types.js';
import {
  RosterEntry,
  SnapshotEntity,
  SnapshotBulletEntity
} from '../shared/schemas.js';
import { NetgraphHUD, NetgraphMetrics } from './netgraph.js';

export interface RenderableShip {
  readonly slotIndex: SlotIndex;
  readonly name: string;
  readonly position: Vec2;
  readonly angle: number;
  readonly hp: number;
  readonly thrusting: boolean;
  readonly isRespawning: boolean;
}

export interface RenderState {
  readonly roomName: string | null;
  readonly seed: Seed | null;
  readonly roster: readonly RosterEntry[];
  readonly obstacles: readonly Obstacle[];
  readonly localShip: RenderableShip | null;
  readonly serverGhostShip: RenderableShip | null;
  readonly showServerGhost: boolean;
  readonly remoteShips: readonly RenderableShip[];
  readonly predictedBullets: readonly { readonly ownerSlot: SlotIndex; readonly position: Vec2 }[];
  readonly snapshotEntities: readonly SnapshotEntity[];
}

interface StarPoint {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly alpha: number;
}

export class ArenaRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stars: readonly StarPoint[];

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to initialize 2D canvas rendering context');
    }
    this.ctx = context;
    this.stars = this.createStarfield();
  }

  private createStarfield(): readonly StarPoint[] {
    const stars: StarPoint[] = [];
    let s = 424242;
    for (let i = 0; i < 95; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const x = ((s % 10000) / 10000) * WORLD_WIDTH;
      s = (s * 1664525 + 1013904223) >>> 0;
      const y = ((s % 10000) / 10000) * WORLD_HEIGHT;
      const size = i % 3 === 0 ? 2 : 1.2;
      const alpha = 0.25 + (i % 5) * 0.14;
      stars.push({ x, y, size, alpha });
    }
    return stars;
  }

  render(state: RenderState, netgraphHud: NetgraphHUD, netMetrics: NetgraphMetrics): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
    ctx.lineWidth = 1;
    const gridStep = 50;
    for (let gx = gridStep; gx < WORLD_WIDTH; gx += gridStep) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, WORLD_HEIGHT);
      ctx.stroke();
    }
    for (let gy = gridStep; gy < WORLD_HEIGHT; gy += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(WORLD_WIDTH, gy);
      ctx.stroke();
    }

    for (const st of this.stars) {
      ctx.fillStyle = `rgba(226, 232, 240, ${st.alpha})`;
      ctx.fillRect(st.x, st.y, st.size, st.size);
    }

    for (const obs of state.obstacles) {
      this.drawAsteroid(ctx, obs);
    }

    // Immediate predicted local bullets
    for (const b of state.predictedBullets) {
      this.drawBullet(ctx, b.ownerSlot, b.position, true);
    }

    // Discriminated union switch over snapshot entities (`kind`: 'ship' | 'bullet')
    for (const entity of state.snapshotEntities) {
      switch (entity.kind) {
        case 'bullet':
          this.drawSnapshotBullet(ctx, entity);
          break;
        case 'ship':
          // Ships are drawn via local predicted ship, interpolated remote ships, and optional ghost
          break;
        default:
          assertNever(entity);
      }
    }

    if (state.showServerGhost && state.serverGhostShip && !state.serverGhostShip.isRespawning) {
      this.drawShipGhost(ctx, state.serverGhostShip);
    }

    for (const remote of state.remoteShips) {
      if (!remote.isRespawning) {
        this.drawShip(ctx, remote, false);
      }
    }

    if (state.localShip && !state.localShip.isRespawning) {
      this.drawShip(ctx, state.localShip, true);
    }

    this.drawTopLeftHud(ctx, state);
    netgraphHud.draw(ctx, WORLD_WIDTH, netMetrics);
  }

  private drawAsteroid(ctx: CanvasRenderingContext2D, obs: Obstacle): void {
    ctx.save();
    ctx.translate(obs.position.x, obs.position.y);
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;

    ctx.beginPath();
    const sides = 10;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const r = obs.radius * (0.9 + ((i * 7 + obs.id) % 3) * 0.05);
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawSnapshotBullet(ctx: CanvasRenderingContext2D, bullet: SnapshotBulletEntity): void {
    this.drawBullet(ctx, bullet.ownerSlot, bullet.position, false);
  }

  private drawBullet(
    ctx: CanvasRenderingContext2D,
    ownerSlot: SlotIndex,
    position: Vec2,
    isPredictedLocal: boolean
  ): void {
    const color = SHIP_COLORS[ownerSlot % SHIP_COLORS.length] ?? '#38bdf8';
    ctx.save();
    ctx.fillStyle = isPredictedLocal ? '#ffffff' : color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(position.x, position.y, BULLET_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawShipGhost(ctx: CanvasRenderingContext2D, ship: RenderableShip): void {
    ctx.save();
    ctx.translate(ship.position.x, ship.position.y);
    ctx.rotate(ship.angle);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.7)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(SHIP_RADIUS + 4, 0);
    ctx.lineTo(-SHIP_RADIUS, -SHIP_RADIUS * 0.78);
    ctx.lineTo(-SHIP_RADIUS * 0.55, 0);
    ctx.lineTo(-SHIP_RADIUS, SHIP_RADIUS * 0.78);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawShip(ctx: CanvasRenderingContext2D, ship: RenderableShip, isLocal: boolean): void {
    const color = SHIP_COLORS[ship.slotIndex % SHIP_COLORS.length] ?? '#38bdf8';

    ctx.save();
    ctx.translate(ship.position.x, ship.position.y);

    ctx.save();
    ctx.rotate(ship.angle);

    if (ship.thrusting) {
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(-SHIP_RADIUS * 0.65, -5);
      ctx.lineTo(-SHIP_RADIUS - 11, 0);
      ctx.lineTo(-SHIP_RADIUS * 0.65, 5);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = isLocal ? color : 'rgba(15, 23, 42, 0.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(SHIP_RADIUS + 4, 0);
    ctx.lineTo(-SHIP_RADIUS, -SHIP_RADIUS * 0.78);
    ctx.lineTo(-SHIP_RADIUS * 0.55, 0);
    ctx.lineTo(-SHIP_RADIUS, SHIP_RADIUS * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const label = isLocal ? `${ship.name} (YOU)` : `${ship.name} [INTERP]`;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(label, 0, -SHIP_RADIUS - 14);

    const barW = 36;
    const barH = 4;
    const hpRatio = Math.max(0, Math.min(1, ship.hp / MAX_HP));
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(-barW / 2, -SHIP_RADIUS - 10, barW, barH);
    ctx.fillStyle = hpRatio > 0.4 ? '#34d399' : '#fb7185';
    ctx.fillRect(-barW / 2, -SHIP_RADIUS - 10, barW * hpRatio, barH);

    ctx.restore();
  }

  private drawTopLeftHud(ctx: CanvasRenderingContext2D, state: RenderState): void {
    ctx.save();
    ctx.fillStyle = 'rgba(11, 17, 32, 0.78)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(14, 14, 235, 86, 8);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`ROOM: ${state.roomName ?? 'NONE'} | SEED: ${state.seed ?? '-'}`, 24, 32);

    if (state.roster.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.fillText('Waiting for pilots...', 24, 54);
    } else {
      state.roster.slice(0, 3).forEach((p, idx) => {
        const y = 52 + idx * 17;
        ctx.fillStyle = p.color;
        ctx.fillText(`● ${p.name}`, 24, y);
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'right';
        ctx.fillText(`HP:${p.hp} | FRAGS:${p.score}`, 238, y);
        ctx.textAlign = 'left';
      });
    }

    if (state.localShip && state.localShip.isRespawning) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(WORLD_WIDTH / 2 - 150, WORLD_HEIGHT / 2 - 26, 300, 52);
      ctx.strokeStyle = '#fb7185';
      ctx.strokeRect(WORLD_WIDTH / 2 - 150, WORLD_HEIGHT / 2 - 26, 300, 52);
      ctx.fillStyle = '#fb7185';
      ctx.font = 'bold 15px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SHIP DESTROYED — RESPAWNING...', WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 5);
    }

    ctx.restore();
  }
}
