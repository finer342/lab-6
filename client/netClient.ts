// Strict TypeScript WebSocket client using parseServerMessage(unknown),
// binary/JSON switching, RTT synchronization, and artificial network impairment.

import { ProtocolMode } from '../shared/types.js';
import {
  ClientMessage,
  ServerMessage,
  SnapshotPacket,
  PongPacket
} from '../shared/schemas.js';
import {
  BinaryGamePacket,
  encodeGamePacket,
  parseServerMessage
} from '../shared/protocol.js';

export interface NetClientHandlers {
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  readonly onServerMessage?: (msg: ServerMessage) => void;
  readonly onSnapshot?: (snapshot: SnapshotPacket, byteLength: number) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  connected = false;
  protocolMode: ProtocolMode = 'binary';

  simDelayMs = 50;
  simJitterMs = 10;
  simLossPercent = 0;

  rttMs = 100;
  private clockOffsetMs = 0;
  private hasClockSync = false;

  private rxBytesAccumulator = 0;
  private txBytesAccumulator = 0;
  rxBytesPerSec = 0;
  txBytesPerSec = 0;
  lastTxPacketBytes = 0;
  lastRxPacketBytes = 0;

  private pingTimer: number | null = null;
  private bwTimer: number | null = null;

  constructor(private readonly handlers: NetClientHandlers = {}) {}

  connect(initialProtocol: ProtocolMode = 'binary'): void {
    this.protocolMode = initialProtocol;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}`;

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      this.connected = true;
      this.sendControl({ type: 'set_protocol', protocol: this.protocolMode });
      this.handlers.onConnect?.();
      this.startTimers();
    };

    socket.onclose = () => {
      this.connected = false;
      this.stopTimers();
      this.handlers.onDisconnect?.();
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      const raw: unknown = event.data;

      // Control JSON messages bypass artificial gameplay packet lag
      if (typeof raw === 'string') {
        const parsedCtrl = parseServerMessage(raw);
        if (!parsedCtrl.ok) {
          console.warn('[NetClient] Dropped invalid server text frame:', parsedCtrl.error);
          return;
        }
        const msg = parsedCtrl.value.message;
        if (msg.type !== 'snapshot' && msg.type !== 'pong') {
          this.handlers.onServerMessage?.(msg);
          return;
        }
      }

      this.scheduleImpaired(() => {
        const parsedGame = parseServerMessage(raw);
        if (!parsedGame.ok) {
          console.warn('[NetClient] Dropped invalid game frame:', parsedGame.error);
          return;
        }

        const { message, byteLength } = parsedGame.value;
        this.rxBytesAccumulator += byteLength;
        this.lastRxPacketBytes = byteLength;

        if (message.type === 'pong') {
          this.handlePong(message);
        } else if (message.type === 'snapshot') {
          this.handlers.onSnapshot?.(message, byteLength);
        }
      });
    };
  }

  private startTimers(): void {
    this.stopTimers();
    this.pingTimer = window.setInterval(() => {
      if (!this.connected) return;
      this.sendGamePacket({
        type: 'ping',
        clientSendTime: performance.now()
      });
    }, 400);

    this.bwTimer = window.setInterval(() => {
      this.rxBytesPerSec = this.rxBytesAccumulator;
      this.txBytesPerSec = this.txBytesAccumulator;
      this.rxBytesAccumulator = 0;
      this.txBytesAccumulator = 0;
    }, 1000);
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.bwTimer !== null) {
      clearInterval(this.bwTimer);
      this.bwTimer = null;
    }
  }

  private handlePong(pong: PongPacket): void {
    const now = performance.now();
    const sampleRtt = Math.max(1, now - pong.clientSendTime);
    this.rttMs = this.rttMs * 0.8 + sampleRtt * 0.2;

    const estimatedOffset = pong.serverTime - (pong.clientSendTime + sampleRtt * 0.5);
    if (!this.hasClockSync) {
      this.clockOffsetMs = estimatedOffset;
      this.hasClockSync = true;
    } else {
      this.clockOffsetMs = this.clockOffsetMs * 0.85 + estimatedOffset * 0.15;
    }
  }

  getEstimatedServerTime(): number {
    return performance.now() + this.clockOffsetMs;
  }

  setProtocolMode(mode: ProtocolMode): void {
    this.protocolMode = mode;
    this.sendControl({ type: 'set_protocol', protocol: mode });
  }

  setNetworkSim(params: {
    readonly delayMs?: number;
    readonly jitterMs?: number;
    readonly lossPercent?: number;
  }): void {
    if (typeof params.delayMs === 'number') this.simDelayMs = params.delayMs;
    if (typeof params.jitterMs === 'number') this.simJitterMs = params.jitterMs;
    if (typeof params.lossPercent === 'number') this.simLossPercent = params.lossPercent;
  }

  private scheduleImpaired(fn: () => void): boolean {
    if (this.simLossPercent > 0 && Math.random() * 100 < this.simLossPercent) {
      return false;
    }
    const jitter = this.simJitterMs > 0 ? (Math.random() * 2 - 1) * this.simJitterMs : 0;
    const delay = Math.max(0, Math.round(this.simDelayMs + jitter));
    if (delay === 0) {
      fn();
    } else {
      setTimeout(fn, delay);
    }
    return true;
  }

  sendControl(message: ClientMessage): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  sendGamePacket(packet: BinaryGamePacket): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoded = encodeGamePacket(packet, this.protocolMode);
    const byteLength =
      typeof encoded === 'string'
        ? new TextEncoder().encode(encoded).length
        : encoded.byteLength;

    this.txBytesAccumulator += byteLength;
    this.lastTxPacketBytes = byteLength;

    this.scheduleImpaired(() => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(encoded);
      }
    });
  }
}
