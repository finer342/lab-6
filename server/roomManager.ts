// Strongly typed authoritative room manager & 30Hz target-time simulation loop.

import type { WebSocket } from 'ws';
import {
  FIXED_DT,
  TICK_INTERVAL_MS,
  MAX_PLAYERS_PER_ROOM,
  SHIP_COLORS
} from '../shared/constants.js';
import {
  PlayerId,
  RoomId,
  SlotIndex,
  Seed,
  ProtocolMode,
  WorldState,
  toRoomId,
  toSlotIndex,
  assertNever
} from '../shared/types.js';
import {
  InputPacket,
  SnapshotPacket,
  SnapshotEntity,
  RoomSummary,
  RosterEntry,
  ChatBroadcast,
  ServerMessage
} from '../shared/schemas.js';
import {
  createInitialWorldState,
  createPlayerEntity,
  stepWorld
} from '../shared/simulation.js';
import { encodeGamePacket } from '../shared/protocol.js';
import { hashSeed } from '../shared/prng.js';
import { NetworkConditioner } from './networkSim.js';

export interface ClientSession {
  readonly id: PlayerId;
  name: string;
  readonly ws: WebSocket;
  roomId: RoomId | null;
  protocolMode: ProtocolMode;
  readonly conditioner: NetworkConditioner;
}

export type RoomEvent =
  | { readonly type: 'player_joined'; readonly playerId: PlayerId; readonly slotIndex: SlotIndex }
  | { readonly type: 'player_left'; readonly playerId: PlayerId }
  | { readonly type: 'frag'; readonly killerId: PlayerId; readonly victimId: PlayerId }
  | { readonly type: 'chat_message'; readonly message: ChatBroadcast };

export class GameRoom {
  readonly id: RoomId;
  readonly name: string;
  private seed: Seed;
  world: WorldState;
  private readonly clients = new Map<PlayerId, ClientSession>();
  private readonly inputQueues = new Map<PlayerId, InputPacket[]>();
  private readonly chatHistory: ChatBroadcast[] = [];
  private running = false;
  private tickCount = 0;
  private startTime = 0;

  constructor(id: RoomId, name: string) {
    this.id = id;
    this.name = name;
    this.seed = hashSeed(`${id}-${Date.now()}`);
    this.world = createInitialWorldState(this.seed);
  }

  get playerCount(): number {
    return this.clients.size;
  }

  startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.startTime = performance.now();
    this.scheduleNextTick();
  }

  stopLoop(): void {
    this.running = false;
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    this.tickCount += 1;
    const targetTime = this.startTime + this.tickCount * TICK_INTERVAL_MS;
    const delay = Math.max(0, targetTime - performance.now());

    setTimeout(() => {
      if (!this.running) return;
      this.tick();
      this.scheduleNextTick();
    }, delay);
  }

  private findFreeSlot(): SlotIndex | null {
    const usedSlots = new Set<number>();
    for (const ship of this.world.players.values()) {
      usedSlots.add(ship.slotIndex);
    }
    for (let s = 0; s < MAX_PLAYERS_PER_ROOM; s++) {
      if (!usedSlots.has(s)) {
        return toSlotIndex(s);
      }
    }
    return null;
  }

  private emitRoomEvent(event: RoomEvent): void {
    switch (event.type) {
      case 'player_joined': {
        const member = this.clients.get(event.playerId);
        if (member) {
          this.broadcastSystemChat(`${member.name} joined the arena (Slot #${event.slotIndex + 1}).`);
          this.broadcastRoster();
        }
        break;
      }
      case 'player_left': {
        this.broadcastRoster();
        break;
      }
      case 'frag': {
        const killer = this.world.players.get(event.killerId);
        const victim = this.world.players.get(event.victimId);
        if (killer && victim) {
          this.broadcastSystemChat(`${killer.name} destroyed ${victim.name}!`);
          this.broadcastRoster();
        }
        break;
      }
      case 'chat_message': {
        this.chatHistory.push(event.message);
        if (this.chatHistory.length > 60) {
          this.chatHistory.shift();
        }
        for (const member of this.clients.values()) {
          this.sendControl(member, event.message);
        }
        break;
      }
      default:
        assertNever(event);
    }
  }

  addClient(client: ClientSession): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    if (this.clients.size >= MAX_PLAYERS_PER_ROOM) {
      return { ok: false, error: 'Room is full (max 4 players).' };
    }

    const slotIndex = this.findFreeSlot();
    if (slotIndex === null) {
      return { ok: false, error: 'No free slot available in room.' };
    }

    const ship = createPlayerEntity(client.id, slotIndex, client.name);
    this.clients.set(client.id, client);
    this.world.players.set(client.id, ship);
    this.inputQueues.set(client.id, []);
    client.roomId = this.id;

    this.sendControl(client, {
      type: 'room_joined',
      roomId: this.id,
      roomName: this.name,
      seed: this.seed,
      slotIndex,
      roster: this.getRoster(),
      chatHistory: this.chatHistory.slice(-30)
    });

    this.emitRoomEvent({
      type: 'player_joined',
      playerId: client.id,
      slotIndex
    });

    if (!this.running) {
      this.startLoop();
    }

    return { ok: true };
  }

  removeClient(playerId: PlayerId): void {
    const client = this.clients.get(playerId);
    if (!client) return;

    const leftName = client.name;
    this.clients.delete(playerId);
    this.world.players.delete(playerId);
    this.inputQueues.delete(playerId);
    client.roomId = null;

    this.broadcastSystemChat(`${leftName} left the arena.`);
    this.emitRoomEvent({ type: 'player_left', playerId });

    if (this.clients.size === 0) {
      this.stopLoop();
      this.seed = hashSeed(`${this.id}-${Date.now()}`);
      this.world = createInitialWorldState(this.seed);
      this.chatHistory.length = 0;
    }
  }

  enqueueInput(playerId: PlayerId, inputPacket: InputPacket): void {
    const queue = this.inputQueues.get(playerId);
    if (!queue) return;
    if (queue.length < 30) {
      queue.push(inputPacket);
    }
  }

  addChatMessage(playerId: PlayerId, text: string): void {
    const client = this.clients.get(playerId);
    const ship = this.world.players.get(playerId);
    if (!client || !ship) return;

    const chatMsg: ChatBroadcast = {
      type: 'chat',
      senderId: client.id,
      senderName: client.name,
      slotIndex: ship.slotIndex,
      text,
      timestamp: Date.now()
    };

    this.emitRoomEvent({ type: 'chat_message', message: chatMsg });
  }

  broadcastSystemChat(text: string): void {
    const sysMsg: ChatBroadcast = {
      type: 'chat',
      system: true,
      senderName: 'SERVER',
      text,
      timestamp: Date.now()
    };
    this.emitRoomEvent({ type: 'chat_message', message: sysMsg });
  }

  getRoster(): readonly RosterEntry[] {
    const roster: RosterEntry[] = [];
    for (const ship of this.world.players.values()) {
      const color = SHIP_COLORS[ship.slotIndex % SHIP_COLORS.length] ?? '#38bdf8';
      roster.push({
        id: ship.id,
        slotIndex: ship.slotIndex,
        name: ship.name,
        color,
        score: ship.score,
        hp: ship.hp
      });
    }
    return roster.sort((a, b) => a.slotIndex - b.slotIndex);
  }

  broadcastRoster(): void {
    const payload: ServerMessage = {
      type: 'roster_update',
      roster: this.getRoster()
    };
    for (const member of this.clients.values()) {
      this.sendControl(member, payload);
    }
  }

  private sendControl(client: ClientSession, message: ServerMessage): void {
    if (client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(message));
    }
  }

  private tick(): void {
    const tickInputs = new Map<PlayerId, InputPacket>();
    for (const [playerId, queue] of this.inputQueues.entries()) {
      const nextInput = queue.shift();
      if (nextInput) {
        tickInputs.set(playerId, nextInput);
      }
    }

    const events = stepWorld(this.world, tickInputs, FIXED_DT);
    for (const ev of events) {
      switch (ev.kind) {
        case 'frag':
          this.emitRoomEvent({
            type: 'frag',
            killerId: ev.killerId,
            victimId: ev.victimId
          });
          break;
        default:
          assertNever(ev.kind);
      }
    }

    const entities: SnapshotEntity[] = [];
    for (const p of this.world.players.values()) {
      entities.push({
        kind: 'ship',
        slotIndex: p.slotIndex,
        lastProcessedSeq: p.lastProcessedSeq,
        position: p.position,
        velocity: p.velocity,
        angle: p.angle,
        hp: p.hp,
        score: p.score,
        isRespawning: p.respawnTimer > 0,
        thrusting: p.thrusting
      });
    }

    for (const b of this.world.bullets) {
      entities.push({
        kind: 'bullet',
        id: b.id,
        ownerSlot: b.ownerSlot,
        clientBulletSeq: b.clientBulletSeq,
        position: b.position,
        velocity: b.velocity
      });
    }

    const snapshot: SnapshotPacket = {
      type: 'snapshot',
      serverTick: this.world.tick,
      serverTimestamp: performance.now(),
      entities
    };

    let binaryCache: ArrayBuffer | string | null = null;
    let jsonCache: ArrayBuffer | string | null = null;

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== 1) continue;

      let packet: ArrayBuffer | string;
      if (client.protocolMode === 'json') {
        if (jsonCache === null) {
          jsonCache = encodeGamePacket(snapshot, 'json');
        }
        packet = jsonCache;
      } else {
        if (binaryCache === null) {
          binaryCache = encodeGamePacket(snapshot, 'binary');
        }
        packet = binaryCache;
      }

      client.conditioner.send(() => {
        if (client.ws.readyState === 1) {
          client.ws.send(packet);
        }
      });
    }
  }
}

export class RoomManager {
  readonly rooms = new Map<RoomId, GameRoom>();
  readonly clients = new Map<PlayerId, ClientSession>();
  nextClientNum = 1;

  constructor() {
    this.createRoom(toRoomId('alpha'), 'Alpha Sector (1v1)');
    this.createRoom(toRoomId('nebula'), 'Nebula Station');
  }

  createRoom(id: RoomId, name: string): GameRoom {
    const existing = this.rooms.get(id);
    if (existing) return existing;

    const room = new GameRoom(id, name);
    this.rooms.set(id, room);
    return room;
  }

  getRoomList(): readonly RoomSummary[] {
    return Array.from(this.rooms.values()).map((r) => ({
      id: r.id,
      name: r.name,
      playerCount: r.playerCount,
      maxPlayers: MAX_PLAYERS_PER_ROOM
    }));
  }

  broadcastRoomList(): void {
    const msg: ServerMessage = {
      type: 'room_list',
      rooms: this.getRoomList()
    };
    const payload = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === 1) {
        client.ws.send(payload);
      }
    }
  }
}
