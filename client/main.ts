// Strict TypeScript client loop:
// - Branded InputSeq & TickNumber
// - Readonly Vec2 kinematics
// - Client-side prediction, server reconciliation, 100ms smoothing, and entity interpolation
// - Exhaustive `switch` over ServerMessage.type and SnapshotEntity.kind with `assertNever`

import {
  FIXED_DT,
  INTERPOLATION_DELAY_MS,
  RECONCILIATION_SMOOTH_MS,
  SHIP_COLORS
} from '../shared/constants.js';
import {
  Vec2,
  vec2,
  ZERO_VEC2,
  addVec2,
  scaleVec2,
  PlayerId,
  RoomId,
  SlotIndex,
  Seed,
  InputSeq,
  ClientBulletSeq,
  Obstacle,
  ShipState,
  RingBuffer,
  toSlotIndex,
  toInputSeq,
  nextInputSeq,
  assertNever
} from '../shared/types.js';
import {
  InputPacket,
  SnapshotPacket,
  SnapshotShipEntity,
  SnapshotBulletEntity,
  ServerMessage,
  RoomSummary,
  RosterEntry,
  ChatBroadcast
} from '../shared/schemas.js';
import {
  generateArenaObstacles,
  createPlayerEntity,
  stepShip,
  normalizeAngle
} from '../shared/simulation.js';
import { NetClient } from './netClient.js';
import { ArenaRenderer, RenderableShip } from './renderer.js';
import { NetgraphHUD } from './netgraph.js';

function getRequiredElement<T extends HTMLElement>(id: string, ctor: { new (): T }): T {
  const el = document.getElementById(id);
  if (!el || !(el instanceof ctor)) {
    throw new Error(`Missing or invalid DOM element #${id}`);
  }
  return el;
}

const urlParams = new URLSearchParams(window.location.search);
const initialProtocol = urlParams.get('protocol') === 'json' ? 'json' : 'binary';
const initialPrediction = urlParams.get('predict') !== '0';

// Strongly-typed DOM bindings
const connStatusEl = getRequiredElement('connStatus', HTMLElement);
const roomPillEl = getRequiredElement('roomPill', HTMLElement);
const protoPillEl = getRequiredElement('protoPill', HTMLElement);
const pilotNameInput = getRequiredElement('pilotNameInput', HTMLInputElement);
const saveNameBtn = getRequiredElement('saveNameBtn', HTMLButtonElement);
const newRoomInput = getRequiredElement('newRoomInput', HTMLInputElement);
const createRoomBtn = getRequiredElement('createRoomBtn', HTMLButtonElement);
const roomListEl = getRequiredElement('roomList', HTMLElement);
const rosterListEl = getRequiredElement('rosterList', HTMLElement);
const chatMessagesEl = getRequiredElement('chatMessages', HTMLElement);
const chatForm = getRequiredElement('chatForm', HTMLFormElement);
const chatInput = getRequiredElement('chatInput', HTMLInputElement);

const predictionToggle = getRequiredElement('predictionToggle', HTMLInputElement);
const binaryToggle = getRequiredElement('binaryToggle', HTMLInputElement);
const ghostToggle = getRequiredElement('ghostToggle', HTMLInputElement);
const randomBugToggle = getRequiredElement('randomBugToggle', HTMLInputElement);

const delaySlider = getRequiredElement('delaySlider', HTMLInputElement);
const jitterSlider = getRequiredElement('jitterSlider', HTMLInputElement);
const lossSlider = getRequiredElement('lossSlider', HTMLInputElement);
const delayValEl = getRequiredElement('delayVal', HTMLElement);
const jitterValEl = getRequiredElement('jitterVal', HTMLElement);
const lossValEl = getRequiredElement('lossVal', HTMLElement);

const lastTxSizeEl = getRequiredElement('lastTxSize', HTMLElement);
const lastRxSizeEl = getRequiredElement('lastRxSize', HTMLElement);
const gameCanvas = getRequiredElement('gameCanvas', HTMLCanvasElement);

predictionToggle.checked = initialPrediction;
binaryToggle.checked = initialProtocol === 'binary';

interface PredictedLocalBullet {
  readonly ownerSlot: SlotIndex;
  readonly clientBulletSeq: ClientBulletSeq;
  position: Vec2;
  readonly velocity: Vec2;
  ttl: number;
}

interface ClientAppState {
  playerId: PlayerId | null;
  playerName: string;
  roomId: RoomId | null;
  roomName: string | null;
  seed: Seed | null;
  mySlot: SlotIndex;
  roster: readonly RosterEntry[];
  obstacles: readonly Obstacle[];

  authoritativeShip: RenderableShip | null;
  predictedShip: ShipState | null;
  visualOffsetPos: Vec2;
  visualOffsetAngle: number;
  lastCorrectionPx: number;

  nextSeq: InputSeq;
  pendingInputs: InputPacket[];

  readonly snapshotBuffer: RingBuffer<SnapshotPacket>;
  latestSnapshotTime: number;

  predictedBullets: PredictedLocalBullet[];
  latestSnapshot: SnapshotPacket | null;

  predictionEnabled: boolean;
  showServerGhost: boolean;
  injectRandomNoise: boolean;
}

const state: ClientAppState = {
  playerId: null,
  playerName: 'Pilot',
  roomId: null,
  roomName: null,
  seed: null,
  mySlot: toSlotIndex(0),
  roster: [],
  obstacles: [],

  authoritativeShip: null,
  predictedShip: null,
  visualOffsetPos: ZERO_VEC2,
  visualOffsetAngle: 0,
  lastCorrectionPx: 0,

  nextSeq: toInputSeq(1),
  pendingInputs: [],

  snapshotBuffer: new RingBuffer<SnapshotPacket>(30),
  latestSnapshotTime: performance.now(),

  predictedBullets: [],
  latestSnapshot: null,

  predictionEnabled: initialPrediction,
  showServerGhost: true,
  injectRandomNoise: false
};

const keys = {
  thrust: false,
  left: false,
  right: false,
  fire: false
};

const renderer = new ArenaRenderer(gameCanvas);
const netgraph = new NetgraphHUD(110);

const net = new NetClient({
  onConnect() {
    connStatusEl.textContent = 'Connected';
    connStatusEl.className = 'pill pill-online';
    updateProtocolPill(net.protocolMode);
  },
  onDisconnect() {
    connStatusEl.textContent = 'Disconnected';
    connStatusEl.className = 'pill pill-offline';
  },
  onServerMessage(msg) {
    handleServerMessage(msg);
  },
  onSnapshot(snapshot) {
    handleServerSnapshot(snapshot);
  }
});

net.connect(initialProtocol);

function updateProtocolPill(mode: 'binary' | 'json'): void {
  if (mode === 'json') {
    protoPillEl.textContent = 'JSON (Zod Validated)';
    protoPillEl.className = 'pill pill-json';
  } else {
    protoPillEl.textContent = 'BINARY (DataView LE)';
    protoPillEl.className = 'pill pill-binary';
  }
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome': {
      state.playerId = msg.playerId;
      state.playerName = msg.playerName;
      pilotNameInput.value = msg.playerName;
      renderRoomList(msg.rooms);
      const firstRoom = msg.rooms[0];
      if (firstRoom && !state.roomId) {
        net.sendControl({ type: 'join_room', roomId: firstRoom.id });
      }
      break;
    }

    case 'room_list': {
      renderRoomList(msg.rooms);
      break;
    }

    case 'room_joined': {
      state.roomId = msg.roomId;
      state.roomName = msg.roomName;
      state.seed = msg.seed;
      state.mySlot = msg.slotIndex;
      state.roster = msg.roster;
      state.obstacles = generateArenaObstacles(msg.seed);

      if (state.playerId) {
        const initialShip = createPlayerEntity(state.playerId, state.mySlot, state.playerName);
        state.predictedShip = initialShip;
        state.authoritativeShip = {
          slotIndex: initialShip.slotIndex,
          name: initialShip.name,
          position: initialShip.position,
          angle: initialShip.angle,
          hp: initialShip.hp,
          thrusting: initialShip.thrusting,
          isRespawning: false
        };
      }

      state.visualOffsetPos = ZERO_VEC2;
      state.visualOffsetAngle = 0;
      state.lastCorrectionPx = 0;
      state.nextSeq = toInputSeq(1);
      state.pendingInputs = [];
      state.snapshotBuffer.clear();
      state.predictedBullets = [];
      state.latestSnapshot = null;

      roomPillEl.textContent = `Room: ${msg.roomName}`;
      renderRoster();
      chatMessagesEl.innerHTML = '';
      for (const line of msg.chatHistory) {
        appendChatLine(line);
      }
      break;
    }

    case 'roster_update': {
      state.roster = msg.roster;
      renderRoster();
      break;
    }

    case 'chat': {
      appendChatLine(msg);
      break;
    }

    case 'protocol_ack': {
      updateProtocolPill(msg.protocol);
      break;
    }

    case 'error': {
      appendChatLine({
        type: 'chat',
        system: true,
        senderName: 'SERVER',
        text: `Error: ${msg.message}`,
        timestamp: Date.now()
      });
      break;
    }

    case 'snapshot':
      handleServerSnapshot(msg);
      break;

    case 'pong':
      break;

    default:
      assertNever(msg);
  }
}

function renderRoomList(rooms: readonly RoomSummary[]): void {
  roomListEl.innerHTML = '';
  for (const r of rooms) {
    const row = document.createElement('div');
    row.className = `room-item ${r.id === state.roomId ? 'active' : ''}`;
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(r.name)}</strong>
        <div class="sub">${r.playerCount}/${r.maxPlayers} pilots</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = r.id === state.roomId ? 'Joined' : 'Join';
    btn.disabled = r.id === state.roomId;
    btn.onclick = () => net.sendControl({ type: 'join_room', roomId: r.id });
    row.appendChild(btn);
    roomListEl.appendChild(row);
  }
}

function renderRoster(): void {
  if (state.roster.length === 0) {
    rosterListEl.innerHTML = '<div class="muted">No pilots in room</div>';
    return;
  }
  rosterListEl.innerHTML = '';
  for (const p of state.roster) {
    const item = document.createElement('div');
    item.className = 'roster-item';
    item.innerHTML = `
      <span><i class="dot" style="background:${p.color}"></i>${escapeHtml(p.name)}</span>
      <strong>${p.score} frags</strong>
    `;
    rosterListEl.appendChild(item);
  }
}

function appendChatLine(msg: ChatBroadcast): void {
  const div = document.createElement('div');
  if (msg.system) {
    div.className = 'chat-line system';
    div.textContent = `• ${msg.text}`;
  } else {
    div.className = 'chat-line';
    const slot = msg.slotIndex ?? toSlotIndex(0);
    const color = SHIP_COLORS[slot % SHIP_COLORS.length] ?? '#38bdf8';
    div.innerHTML = `<strong style="color:${color}">${escapeHtml(msg.senderName)}:</strong> ${escapeHtml(msg.text)}`;
  }
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractShipsAndBullets(snapshot: SnapshotPacket): {
  readonly ships: readonly SnapshotShipEntity[];
  readonly bullets: readonly SnapshotBulletEntity[];
} {
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
        assertNever(entity);
    }
  }
  return { ships, bullets };
}

function handleServerSnapshot(snapshot: SnapshotPacket): void {
  state.latestSnapshotTime = performance.now();
  state.latestSnapshot = snapshot;
  state.snapshotBuffer.push(snapshot);

  const { ships, bullets } = extractShipsAndBullets(snapshot);
  const myServerShip = ships.find((s) => s.slotIndex === state.mySlot);
  if (!myServerShip || !state.predictedShip) return;

  const prevVisPos = addVec2(state.predictedShip.position, state.visualOffsetPos);
  const prevVisAngle = normalizeAngle(state.predictedShip.angle + state.visualOffsetAngle);

  state.authoritativeShip = {
    slotIndex: myServerShip.slotIndex,
    name: state.playerName,
    position: myServerShip.position,
    angle: myServerShip.angle,
    hp: myServerShip.hp,
    thrusting: myServerShip.thrusting,
    isRespawning: myServerShip.isRespawning
  };

  // Discard inputs already acknowledged by the authoritative server
  const ackSeq = myServerShip.lastProcessedSeq;
  state.pendingInputs = state.pendingInputs.filter((inp) => inp.seq > ackSeq);

  if (!state.predictionEnabled) {
    state.predictedShip.position = myServerShip.position;
    state.predictedShip.velocity = myServerShip.velocity;
    state.predictedShip.angle = myServerShip.angle;
    state.predictedShip.hp = myServerShip.hp;
    state.predictedShip.score = myServerShip.score;
    state.predictedShip.thrusting = myServerShip.thrusting;
    state.predictedShip.respawnTimer = myServerShip.isRespawning ? 1.0 : 0;
    state.visualOffsetPos = ZERO_VEC2;
    state.visualOffsetAngle = 0;
    state.lastCorrectionPx = 0;
  } else {
    // Reset to authoritative server snapshot and replay unconfirmed inputs
    state.predictedShip.position = myServerShip.position;
    state.predictedShip.velocity = myServerShip.velocity;
    state.predictedShip.angle = myServerShip.angle;
    state.predictedShip.hp = myServerShip.hp;
    state.predictedShip.score = myServerShip.score;
    state.predictedShip.thrusting = myServerShip.thrusting;
    state.predictedShip.respawnTimer = myServerShip.isRespawning ? 1.0 : 0;

    for (let i = 0; i < state.pendingInputs.length; i++) {
      const pending = state.pendingInputs[i];
      if (!pending) continue;
      stepShip(state.predictedShip, pending, FIXED_DT, state.obstacles, {
        injectRandomNoise: state.injectRandomNoise
      });
    }

    const errX = prevVisPos.x - state.predictedShip.position.x;
    const errY = prevVisPos.y - state.predictedShip.position.y;
    const errAngle = normalizeAngle(prevVisAngle - state.predictedShip.angle);
    const correctionMag = Math.hypot(errX, errY);

    state.lastCorrectionPx = correctionMag;

    if (correctionMag > 160) {
      state.visualOffsetPos = ZERO_VEC2;
      state.visualOffsetAngle = 0;
    } else {
      state.visualOffsetPos = vec2(errX, errY);
      state.visualOffsetAngle = errAngle;
    }
  }

  // Deduplicate immediate local bullets against confirmed server bullets
  const confirmedSeqs = new Set<number>(
    bullets
      .filter((b) => b.ownerSlot === state.mySlot)
      .map((b) => b.clientBulletSeq & 0xff)
  );
  state.predictedBullets = state.predictedBullets.filter(
    (pb) => !confirmedSeqs.has(pb.clientBulletSeq & 0xff) && pb.ttl > 0
  );
}

function getInterpolatedRemoteShips(): readonly RenderableShip[] {
  const buf = state.snapshotBuffer.values();
  const firstSnap = buf[0];
  const lastSnap = buf[buf.length - 1];
  if (!firstSnap || !lastSnap) return [];

  const renderServerTime = net.getEstimatedServerTime() - INTERPOLATION_DELAY_MS;

  let snap0 = firstSnap;
  let snap1 = lastSnap;

  for (let i = 0; i < buf.length - 1; i++) {
    const s0 = buf[i];
    const s1 = buf[i + 1];
    if (s0 && s1 && s0.serverTimestamp <= renderServerTime && s1.serverTimestamp >= renderServerTime) {
      snap0 = s0;
      snap1 = s1;
      break;
    }
  }

  const span = snap1.serverTimestamp - snap0.serverTimestamp;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (renderServerTime - snap0.serverTimestamp) / span)) : 1;

  const { ships: ships0 } = extractShipsAndBullets(snap0);
  const { ships: ships1 } = extractShipsAndBullets(snap1);

  const remotes: RenderableShip[] = [];
  for (const p1 of ships1) {
    if (p1.slotIndex === state.mySlot) continue;
    const p0 = ships0.find((p) => p.slotIndex === p1.slotIndex) ?? p1;
    const rosterEntry = state.roster.find((r) => r.slotIndex === p1.slotIndex);

    const deltaAngle = normalizeAngle(p1.angle - p0.angle);
    remotes.push({
      slotIndex: p1.slotIndex,
      name: rosterEntry?.name ?? `Pilot_${p1.slotIndex + 1}`,
      position: vec2(
        p0.position.x + (p1.position.x - p0.position.x) * alpha,
        p0.position.y + (p1.position.y - p0.position.y) * alpha
      ),
      angle: normalizeAngle(p0.angle + deltaAngle * alpha),
      hp: p1.hp,
      thrusting: p1.thrusting,
      isRespawning: p1.isRespawning
    });
  }

  return remotes;
}

let simAccumulator = 0;
let lastFrameTime = performance.now();

function stepFixedClientTick(): void {
  if (!state.roomId || !state.predictedShip) return;

  const seq = state.nextSeq;
  state.nextSeq = nextInputSeq(seq);

  const inputFrame: InputPacket = {
    type: 'input',
    seq,
    thrust: keys.thrust,
    left: keys.left,
    right: keys.right,
    fire: keys.fire,
    clientTimeMs: Math.round(performance.now()) >>> 0
  };

  net.sendGamePacket(inputFrame);

  if (state.predictionEnabled) {
    state.pendingInputs.push(inputFrame);
    if (state.pendingInputs.length > 90) {
      state.pendingInputs.shift();
    }

    const { spawnedBullet } = stepShip(
      state.predictedShip,
      inputFrame,
      FIXED_DT,
      state.obstacles,
      { injectRandomNoise: state.injectRandomNoise }
    );

    if (spawnedBullet) {
      state.predictedBullets.push({
        ownerSlot: spawnedBullet.ownerSlot,
        clientBulletSeq: spawnedBullet.clientBulletSeq,
        position: spawnedBullet.position,
        velocity: spawnedBullet.velocity,
        ttl: spawnedBullet.ttl
      });
    }
  }
}

function frameLoop(now: number): void {
  const frameDt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  simAccumulator += frameDt;
  while (simAccumulator >= FIXED_DT) {
    stepFixedClientTick();
    simAccumulator -= FIXED_DT;
  }

  // Smooth reconciliation offset over ~100ms
  const smoothFactor = Math.min(1, frameDt / (RECONCILIATION_SMOOTH_MS / 1000));
  const nextOffX = state.visualOffsetPos.x * (1 - smoothFactor);
  const nextOffY = state.visualOffsetPos.y * (1 - smoothFactor);
  state.visualOffsetAngle *= 1 - smoothFactor;

  if (Math.hypot(nextOffX, nextOffY) < 0.05) {
    state.visualOffsetPos = ZERO_VEC2;
  } else {
    state.visualOffsetPos = vec2(nextOffX, nextOffY);
  }

  for (let i = state.predictedBullets.length - 1; i >= 0; i--) {
    const b = state.predictedBullets[i];
    if (!b) continue;
    b.position = addVec2(b.position, scaleVec2(b.velocity, frameDt));
    b.ttl -= frameDt;
    if (b.ttl <= 0) {
      state.predictedBullets.splice(i, 1);
    }
  }

  const visualLocalShip: RenderableShip | null = state.predictedShip
    ? {
        slotIndex: state.predictedShip.slotIndex,
        name: state.predictedShip.name,
        position: addVec2(state.predictedShip.position, state.visualOffsetPos),
        angle: normalizeAngle(state.predictedShip.angle + state.visualOffsetAngle),
        hp: state.predictedShip.hp,
        thrusting: state.predictedShip.thrusting,
        isRespawning: state.predictedShip.respawnTimer > 0
      }
    : null;

  const snapshotAgeMs = Math.max(0, now - state.latestSnapshotTime);
  netgraph.recordSample(net.rttMs, state.lastCorrectionPx);

  lastTxSizeEl.textContent = `${net.lastTxPacketBytes} B`;
  lastRxSizeEl.textContent = `${net.lastRxPacketBytes} B`;

  renderer.render(
    {
      roomName: state.roomName,
      seed: state.seed,
      roster: state.roster,
      obstacles: state.obstacles,
      localShip: visualLocalShip,
      serverGhostShip: state.authoritativeShip,
      showServerGhost: state.showServerGhost,
      remoteShips: getInterpolatedRemoteShips(),
      predictedBullets: state.predictedBullets,
      snapshotEntities: state.latestSnapshot?.entities ?? []
    },
    netgraph,
    {
      protocolMode: net.protocolMode,
      predictionEnabled: state.predictionEnabled,
      rttMs: net.rttMs,
      snapshotAgeMs,
      rxBytesPerSec: net.rxBytesPerSec,
      txBytesPerSec: net.txBytesPerSec,
      inputQueueLen: state.pendingInputs.length,
      correctionPx: state.lastCorrectionPx
    }
  );

  requestAnimationFrame(frameLoop);
}

requestAnimationFrame(frameLoop);

// Keyboard input listeners
window.addEventListener('keydown', (e: KeyboardEvent) => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return;
  }
  if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.thrust = true;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
  if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
  if (e.code === 'Space') {
    keys.fire = true;
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.thrust = false;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
  if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
  if (e.code === 'Space') keys.fire = false;
});

saveNameBtn.addEventListener('click', () => {
  const name = pilotNameInput.value.trim();
  if (name) {
    state.playerName = name;
    if (state.predictedShip) state.predictedShip.name = name;
    net.sendControl({ type: 'set_name', name });
  }
});

createRoomBtn.addEventListener('click', () => {
  const name = newRoomInput.value.trim() || `Arena ${Math.floor(Math.random() * 90 + 10)}`;
  newRoomInput.value = '';
  net.sendControl({ type: 'create_room', name });
});

chatForm.addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text) {
    net.sendControl({ type: 'chat', text });
    chatInput.value = '';
  }
});

predictionToggle.addEventListener('change', () => {
  state.predictionEnabled = predictionToggle.checked;
  if (!state.predictionEnabled) {
    state.pendingInputs = [];
    state.visualOffsetPos = ZERO_VEC2;
    state.visualOffsetAngle = 0;
  }
});

binaryToggle.addEventListener('change', () => {
  const mode = binaryToggle.checked ? 'binary' : 'json';
  net.setProtocolMode(mode);
  updateProtocolPill(mode);
});

ghostToggle.addEventListener('change', () => {
  state.showServerGhost = ghostToggle.checked;
});

randomBugToggle.addEventListener('change', () => {
  state.injectRandomNoise = randomBugToggle.checked;
});

function syncSimSliders(): void {
  const d = Number(delaySlider.value);
  const j = Number(jitterSlider.value);
  const l = Number(lossSlider.value);
  delayValEl.textContent = `${d} ms (RTT ~${d * 2} ms)`;
  jitterValEl.textContent = `${j} ms`;
  lossValEl.textContent = `${l} %`;
  net.setNetworkSim({ delayMs: d, jitterMs: j, lossPercent: l });
}

delaySlider.addEventListener('input', syncSimSliders);
jitterSlider.addEventListener('input', syncSimSliders);
lossSlider.addEventListener('input', syncSimSliders);

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    if (preset === 'lan') {
      delaySlider.value = '0';
      jitterSlider.value = '0';
      lossSlider.value = '0';
    } else if (preset === 'lab') {
      delaySlider.value = '50';
      jitterSlider.value = '10';
      lossSlider.value = '0';
    } else if (preset === 'lossy') {
      delaySlider.value = '90';
      jitterSlider.value = '25';
      lossSlider.value = '8';
    }
    syncSimSliders();
  });
});

syncSimSliders();
