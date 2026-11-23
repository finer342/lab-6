// Zod runtime validation schemas for all client/server messages and snapshot entities.
// TypeScript types are inferred directly from schemas (z.infer).

import { z } from 'zod';
import {
  toPlayerId,
  toRoomId,
  toBulletId,
  toTickNumber,
  toInputSeq,
  toClientBulletSeq,
  toSlotIndex,
  toSeed
} from './types.js';
import { MAX_PLAYERS_PER_ROOM } from './constants.js';

// Branded primitive Zod schemas
export const PlayerIdSchema = z.string().min(1).max(40).transform(toPlayerId);
export const RoomIdSchema = z.string().min(1).max(40).transform(toRoomId);
export const BulletIdSchema = z.number().int().min(0).max(65535).transform(toBulletId);
export const TickNumberSchema = z.number().int().min(0).transform(toTickNumber);
export const InputSeqSchema = z.number().int().min(0).transform(toInputSeq);
export const ClientBulletSeqSchema = z.number().int().min(0).transform(toClientBulletSeq);
export const SlotIndexSchema = z.number().int().min(0).max(MAX_PLAYERS_PER_ROOM - 1).transform(toSlotIndex);
export const SeedSchema = z.number().int().min(1).transform(toSeed);

export const Vec2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).readonly();

// ---------------------------------------------------------------------------
// Snapshot entities discriminated by `kind` ('ship' | 'bullet')
// ---------------------------------------------------------------------------
export const SnapshotShipEntitySchema = z.object({
  kind: z.literal('ship'),
  slotIndex: SlotIndexSchema,
  lastProcessedSeq: InputSeqSchema,
  position: Vec2Schema,
  velocity: Vec2Schema,
  angle: z.number().finite(),
  hp: z.number().int().min(0).max(255),
  score: z.number().int().min(0).max(255),
  isRespawning: z.boolean(),
  thrusting: z.boolean()
}).readonly();

export const SnapshotBulletEntitySchema = z.object({
  kind: z.literal('bullet'),
  id: BulletIdSchema,
  ownerSlot: SlotIndexSchema,
  clientBulletSeq: ClientBulletSeqSchema,
  position: Vec2Schema,
  velocity: Vec2Schema
}).readonly();

export const SnapshotEntitySchema = z.discriminatedUnion('kind', [
  SnapshotShipEntitySchema,
  SnapshotBulletEntitySchema
]);

export type SnapshotShipEntity = z.infer<typeof SnapshotShipEntitySchema>;
export type SnapshotBulletEntity = z.infer<typeof SnapshotBulletEntitySchema>;
export type SnapshotEntity = z.infer<typeof SnapshotEntitySchema>;

// ---------------------------------------------------------------------------
// Game protocol packets (Binary DataView or JSON fallback)
// ---------------------------------------------------------------------------
export const InputPacketSchema = z.object({
  type: z.literal('input'),
  seq: InputSeqSchema,
  thrust: z.boolean(),
  left: z.boolean(),
  right: z.boolean(),
  fire: z.boolean(),
  clientTimeMs: z.number().int().min(0)
}).readonly();

export const SnapshotPacketSchema = z.object({
  type: z.literal('snapshot'),
  serverTick: TickNumberSchema,
  serverTimestamp: z.number().finite().min(0),
  entities: z.array(SnapshotEntitySchema).readonly()
}).readonly();

export const PingPacketSchema = z.object({
  type: z.literal('ping'),
  clientSendTime: z.number().finite().min(0)
}).readonly();

export const PongPacketSchema = z.object({
  type: z.literal('pong'),
  clientSendTime: z.number().finite().min(0),
  serverTime: z.number().finite().min(0)
}).readonly();

export type InputPacket = z.infer<typeof InputPacketSchema>;
export type SnapshotPacket = z.infer<typeof SnapshotPacketSchema>;
export type PingPacket = z.infer<typeof PingPacketSchema>;
export type PongPacket = z.infer<typeof PongPacketSchema>;

// ---------------------------------------------------------------------------
// Control / Lobby / Chat messages (JSON over WebSocket)
// ---------------------------------------------------------------------------
export const SetNameMessageSchema = z.object({
  type: z.literal('set_name'),
  name: z.string().trim().min(1).max(18)
}).readonly();

export const SetProtocolMessageSchema = z.object({
  type: z.literal('set_protocol'),
  protocol: z.enum(['binary', 'json'])
}).readonly();

export const CreateRoomMessageSchema = z.object({
  type: z.literal('create_room'),
  name: z.string().trim().min(1).max(32)
}).readonly();

export const JoinRoomMessageSchema = z.object({
  type: z.literal('join_room'),
  roomId: RoomIdSchema
}).readonly();

export const LeaveRoomMessageSchema = z.object({
  type: z.literal('leave_room')
}).readonly();

export const ChatSendMessageSchema = z.object({
  type: z.literal('chat'),
  text: z.string().trim().min(1).max(220)
}).readonly();

// Discriminated union of all valid messages sent from Client -> Server
export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputPacketSchema,
  PingPacketSchema,
  SetNameMessageSchema,
  SetProtocolMessageSchema,
  CreateRoomMessageSchema,
  JoinRoomMessageSchema,
  LeaveRoomMessageSchema,
  ChatSendMessageSchema
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Shared sub-schemas for server control messages
export const RoomSummarySchema = z.object({
  id: RoomIdSchema,
  name: z.string(),
  playerCount: z.number().int().min(0),
  maxPlayers: z.number().int().min(1)
}).readonly();

export const RosterEntrySchema = z.object({
  id: PlayerIdSchema,
  slotIndex: SlotIndexSchema,
  name: z.string(),
  color: z.string(),
  score: z.number().int().min(0),
  hp: z.number().int().min(0)
}).readonly();

export const ChatBroadcastSchema = z.object({
  type: z.literal('chat'),
  system: z.boolean().optional(),
  senderId: PlayerIdSchema.optional(),
  senderName: z.string(),
  slotIndex: SlotIndexSchema.optional(),
  text: z.string(),
  timestamp: z.number()
}).readonly();

export const WelcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  playerId: PlayerIdSchema,
  playerName: z.string(),
  defaultProtocol: z.enum(['binary', 'json']),
  rooms: z.array(RoomSummarySchema).readonly()
}).readonly();

export const RoomListMessageSchema = z.object({
  type: z.literal('room_list'),
  rooms: z.array(RoomSummarySchema).readonly()
}).readonly();

export const RoomJoinedMessageSchema = z.object({
  type: z.literal('room_joined'),
  roomId: RoomIdSchema,
  roomName: z.string(),
  seed: SeedSchema,
  slotIndex: SlotIndexSchema,
  roster: z.array(RosterEntrySchema).readonly(),
  chatHistory: z.array(ChatBroadcastSchema).readonly()
}).readonly();

export const RosterUpdateMessageSchema = z.object({
  type: z.literal('roster_update'),
  roster: z.array(RosterEntrySchema).readonly()
}).readonly();

export const ProtocolAckMessageSchema = z.object({
  type: z.literal('protocol_ack'),
  protocol: z.enum(['binary', 'json'])
}).readonly();

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string()
}).readonly();

// Discriminated union of all valid messages sent from Server -> Client
export const ServerMessageSchema = z.discriminatedUnion('type', [
  SnapshotPacketSchema,
  PongPacketSchema,
  WelcomeMessageSchema,
  RoomListMessageSchema,
  RoomJoinedMessageSchema,
  RosterUpdateMessageSchema,
  ChatBroadcastSchema,
  ProtocolAckMessageSchema,
  ErrorMessageSchema
]);

export type RoomSummary = z.infer<typeof RoomSummarySchema>;
export type RosterEntry = z.infer<typeof RosterEntrySchema>;
export type ChatBroadcast = z.infer<typeof ChatBroadcastSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
