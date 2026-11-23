// Strongly typed Netgraph HUD using generic RingBuffer<number> for sparklines.

import { ProtocolMode, RingBuffer } from '../shared/types.js';

export interface NetgraphMetrics {
  readonly protocolMode: ProtocolMode;
  readonly predictionEnabled: boolean;
  readonly rttMs: number;
  readonly snapshotAgeMs: number;
  readonly rxBytesPerSec: number;
  readonly txBytesPerSec: number;
  readonly inputQueueLen: number;
  readonly correctionPx: number;
}

export class NetgraphHUD {
  private readonly rttHistory: RingBuffer<number>;
  private readonly corrHistory: RingBuffer<number>;

  constructor(private readonly maxSamples = 110) {
    this.rttHistory = new RingBuffer<number>(maxSamples);
    this.corrHistory = new RingBuffer<number>(maxSamples);
  }

  recordSample(rttMs: number, correctionPx: number): void {
    this.rttHistory.push(rttMs);
    this.corrHistory.push(correctionPx);
  }

  draw(ctx: CanvasRenderingContext2D, canvasWidth: number, metrics: NetgraphMetrics): void {
    const boxW = 310;
    const boxH = 148;
    const x = canvasWidth - boxW - 14;
    const y = 14;

    ctx.save();
    ctx.fillStyle = 'rgba(11, 17, 32, 0.84)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`NETGRAPH [${metrics.protocolMode.toUpperCase()}]`, x + 10, y + 17);

    ctx.fillStyle = metrics.predictionEnabled ? '#34d399' : '#fbbf24';
    ctx.textAlign = 'right';
    ctx.fillText(metrics.predictionEnabled ? 'PREDICT: ON' : 'PREDICT: OFF', x + boxW - 10, y + 17);
    ctx.textAlign = 'left';

    ctx.font = '11px monospace';
    const col1X = x + 10;
    const col2X = x + 162;

    ctx.fillStyle = '#94a3b8';
    ctx.fillText('RTT:', col1X, y + 36);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`${Math.round(metrics.rttMs)} ms`, col1X + 36, y + 36);

    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Snap Age:', col2X, y + 36);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`${Math.round(metrics.snapshotAgeMs)} ms`, col2X + 68, y + 36);

    const totalBps = metrics.rxBytesPerSec + metrics.txBytesPerSec;
    const bwLabel = totalBps >= 1024 ? `${(totalBps / 1024).toFixed(1)} KB/s` : `${totalBps} B/s`;

    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Bytes/s:', col1X, y + 53);
    ctx.fillStyle = metrics.protocolMode === 'binary' ? '#34d399' : '#fbbf24';
    ctx.fillText(bwLabel, col1X + 58, y + 53);

    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Input Q:', col2X, y + 53);
    ctx.fillStyle = metrics.inputQueueLen > 12 ? '#fb7185' : '#f8fafc';
    ctx.fillText(`${metrics.inputQueueLen}`, col2X + 68, y + 53);

    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Correction:', col1X, y + 70);
    ctx.fillStyle = metrics.correctionPx > 3.0 ? '#fb7185' : '#38bdf8';
    ctx.fillText(`${metrics.correctionPx.toFixed(2)} px`, col1X + 82, y + 70);

    const gx = x + 10;
    const gy = y + 80;
    const gw = boxW - 20;
    const gh = 56;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(gx, gy, gw, gh);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.strokeRect(gx, gy, gw, gh);

    this.drawSparkline(ctx, this.rttHistory.values(), gx, gy, gw, gh, 350, '#38bdf8');
    this.drawSparkline(ctx, this.corrHistory.values(), gx, gy, gw, gh, 25, '#fb7185');

    ctx.font = '9px monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('RTT (0-350ms)', gx + 4, gy + 10);
    ctx.fillStyle = '#fb7185';
    ctx.textAlign = 'right';
    ctx.fillText('Correction (0-25px)', gx + gw - 4, gy + 10);
    ctx.textAlign = 'left';

    ctx.restore();
  }

  private drawSparkline(
    ctx: CanvasRenderingContext2D,
    data: readonly number[],
    gx: number,
    gy: number,
    gw: number,
    gh: number,
    maxVal: number,
    color: string
  ): void {
    if (data.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();

    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (val === undefined) continue;
      const ratioX = i / (this.maxSamples - 1);
      const ratioY = Math.min(1, Math.max(0, val / maxVal));
      const px = gx + ratioX * gw;
      const py = gy + gh - ratioY * (gh - 4) - 2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}
