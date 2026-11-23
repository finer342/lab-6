// Authoritative HTTP + WebSocket server under strict TypeScript.
// Uses parseClientMessage(unknown) with Zod + binary validation; invalid packets log and close the socket.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  PlayerId,
  RoomId,
  toPlayerId,
  toRoomId,
  assertNever
} from '../shared/types.js';
import { ClientMessage, ServerMessage } from '../shared/schemas.js';
import { parseClientMessage, encodeGamePacket } from '../shared/protocol.js';
import { loadServerConfig } from './config.js';
import { RoomManager, ClientSession } from './roomManager.js';
import { NetworkConditioner } from './networkSim.js';

const config = loadServerConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled server runs from dist/server/index.js -> DIST_DIR is dist/, ROOT_DIR is project root
const DIST_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(DIST_DIR, '..');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

function resolveStaticFile(rawUrl: string): { readonly filePath: string; readonly allowedRoot: string } {
  if (rawUrl.startsWith('/shared/')) {
    const rel = path.normalize(rawUrl.replace(/^\/shared\//, ''));
    const allowedRoot = path.join(DIST_DIR, 'shared');
    return { filePath: path.join(allowedRoot, rel), allowedRoot };
  }

  const rel = rawUrl === '/' ? 'index.html' : path.normalize(rawUrl.replace(/^\//, ''));
  if (rel.endsWith('.js') || rel.endsWith('.js.map')) {
    const allowedRoot = path.join(DIST_DIR, 'client');
    return { filePath: path.join(allowedRoot, rel), allowedRoot };
  }

  const allowedRoot = path.join(ROOT_DIR, 'client');
  return { filePath: path.join(allowedRoot, rel), allowedRoot };
}

const httpServer = http.createServer((req, res) => {
  const rawUrl = (req.url ?? '/').split('?')[0] ?? '/';
  const { filePath, allowedRoot } = resolveStaticFile(rawUrl);

  if (!filePath.startsWith(allowedRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

const wss = new WebSocketServer({ server: httpServer });
const roomManager = new RoomManager();

function sendServerControl(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws: WebSocket) => {
  const num = roomManager.nextClientNum++;
  const clientId: PlayerId = toPlayerId(`player-${num}`);

  const client: ClientSession = {
    id: clientId,
    name: `Pilot_${num}`,
    ws,
    roomId: null,
    protocolMode: config.PROTOCOL,
    conditioner: new NetworkConditioner({ delayMs: 0, jitterMs: 0, lossPercent: 0 })
  };

  roomManager.clients.set(client.id, client);

  sendServerControl(ws, {
    type: 'welcome',
    playerId: client.id,
    playerName: client.name,
    defaultProtocol: client.protocolMode,
    rooms: roomManager.getRoomList()
  });

  ws.on('message', (data: unknown, isBinary: boolean) => {
    // Convert string vs binary payload to unknown for unified parseClientMessage(unknown)
    const rawPayload: unknown = isBinary ? data : String(data);
    const parsed = parseClientMessage(rawPayload);

    if (!parsed.ok) {
      // Invalid/corrupt JSON or binary packet: log and close socket cleanly without throwing
      console.warn(`[Server] Closing socket for ${client.id} due to invalid message: ${parsed.error}`);
      ws.close(1008, 'Protocol validation failed');
      return;
    }

    handleClientMessage(client, parsed.value.message);
  });

  ws.on('close', () => {
    if (client.roomId) {
      const room = roomManager.rooms.get(client.roomId);
      if (room) {
        room.removeClient(client.id);
      }
    }
    roomManager.clients.delete(client.id);
    roomManager.broadcastRoomList();
  });
});

function joinClientToRoom(client: ClientSession, roomId: RoomId): void {
  if (client.roomId) {
    const prev = roomManager.rooms.get(client.roomId);
    if (prev) {
      prev.removeClient(client.id);
    }
  }

  const target = roomManager.rooms.get(roomId);
  if (!target) {
    sendServerControl(client.ws, { type: 'error', message: 'Room not found.' });
    return;
  }

  const res = target.addClient(client);
  if (!res.ok) {
    sendServerControl(client.ws, { type: 'error', message: res.error });
  }
}

function handleClientMessage(client: ClientSession, msg: ClientMessage): void {
  switch (msg.type) {
    case 'ping': {
      const pong = encodeGamePacket(
        {
          type: 'pong',
          clientSendTime: msg.clientSendTime,
          serverTime: performance.now()
        },
        client.protocolMode
      );
      client.conditioner.send(() => {
        if (client.ws.readyState === 1) {
          client.ws.send(pong);
        }
      });
      break;
    }

    case 'input': {
      if (!client.roomId) return;
      const room = roomManager.rooms.get(client.roomId);
      if (!room) return;
      room.enqueueInput(client.id, msg);
      break;
    }

    case 'set_name': {
      client.name = msg.name;
      if (client.roomId) {
        const room = roomManager.rooms.get(client.roomId);
        const ship = room?.world.players.get(client.id);
        if (ship) {
          ship.name = msg.name;
        }
        room?.broadcastRoster();
      }
      break;
    }

    case 'set_protocol': {
      client.protocolMode = msg.protocol;
      sendServerControl(client.ws, {
        type: 'protocol_ack',
        protocol: client.protocolMode
      });
      break;
    }

    case 'create_room': {
      const cleanId = toRoomId(`room-${Date.now().toString(36)}`);
      const room = roomManager.createRoom(cleanId, msg.name);
      joinClientToRoom(client, room.id);
      roomManager.broadcastRoomList();
      break;
    }

    case 'join_room': {
      joinClientToRoom(client, msg.roomId);
      roomManager.broadcastRoomList();
      break;
    }

    case 'leave_room': {
      if (client.roomId) {
        const oldRoom = roomManager.rooms.get(client.roomId);
        if (oldRoom) {
          oldRoom.removeClient(client.id);
        }
        roomManager.broadcastRoomList();
      }
      break;
    }

    case 'chat': {
      if (client.roomId) {
        const room = roomManager.rooms.get(client.roomId);
        if (room) {
          room.addChatMessage(client.id, msg.text);
        }
      }
      break;
    }

    default:
      assertNever(msg);
  }
}

httpServer.listen(config.PORT, () => {
  console.log(
    `[Lab 6 TS Server] Listening on http://localhost:${config.PORT} (default protocol: ${config.PROTOCOL.toUpperCase()})`
  );
});
