// Server-side network conditioner (delay, jitter, packet loss).

export interface NetworkSimOptions {
  readonly delayMs?: number;
  readonly jitterMs?: number;
  readonly lossPercent?: number;
}

export class NetworkConditioner {
  private delayMs: number;
  private jitterMs: number;
  private lossPercent: number;

  constructor(options: NetworkSimOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.jitterMs = options.jitterMs ?? 0;
    this.lossPercent = options.lossPercent ?? 0;
  }

  update(options: NetworkSimOptions): void {
    if (typeof options.delayMs === 'number') {
      this.delayMs = Math.max(0, options.delayMs);
    }
    if (typeof options.jitterMs === 'number') {
      this.jitterMs = Math.max(0, options.jitterMs);
    }
    if (typeof options.lossPercent === 'number') {
      this.lossPercent = Math.max(0, Math.min(95, options.lossPercent));
    }
  }

  send(sendFn: () => void): boolean {
    if (this.lossPercent > 0 && Math.random() * 100 < this.lossPercent) {
      return false;
    }

    const jitterOffset = this.jitterMs > 0 ? (Math.random() * 2 - 1) * this.jitterMs : 0;
    const totalDelay = Math.max(0, Math.round(this.delayMs + jitterOffset));

    if (totalDelay === 0) {
      sendFn();
    } else {
      setTimeout(sendFn, totalDelay);
    }
    return true;
  }
}
