export interface IngressLease { release(): void }

/** Admission happens synchronously, before any asynchronous archive writes. */
export class IngressBudget {
  private readonly counts = new Map<string, number>();
  private pending = 0;
  private bytes = 0;
  private closed = false;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: {
    maxPerKey: number;
    maxTotal: number;
    maxBytes: number;
    reservedFraction?: number;
    onChange?: (pending: number, bytes: number) => void;
  }) {
    for (const value of [options.maxPerKey, options.maxTotal, options.maxBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('入站容量必须是正整数');
    }
    if (options.reservedFraction !== undefined && (!Number.isFinite(options.reservedFraction) || options.reservedFraction < 0 || options.reservedFraction >= 1)) throw new Error('直接对话预留比例无效');
  }

  get size(): number { return this.pending; }
  get pendingBytes(): number { return this.bytes; }

  reserve(key: string, bytes: number, direct = false): IngressLease | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('入站消息大小无效');
    const count = this.counts.get(key) ?? 0;
    const limit = (max: number): number => direct ? max : max - Math.min(max - 1, Math.ceil(max * (this.options.reservedFraction ?? 0)));
    if (this.closed || count >= limit(this.options.maxPerKey) || this.pending >= limit(this.options.maxTotal) || bytes > limit(this.options.maxBytes) - this.bytes) return;
    this.pending++; this.bytes += bytes; this.counts.set(key, count + 1);
    this.options.onChange?.(this.pending, this.bytes);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      const count = this.counts.get(key)! - 1;
      if (count) this.counts.set(key, count); else this.counts.delete(key);
      this.pending--; this.bytes -= bytes;
      this.options.onChange?.(this.pending, this.bytes);
      if (this.pending === 0) { for (const done of this.waiters) done(); this.waiters.clear(); }
    } };
  }

  close(): void { this.closed = true; }
  drain(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise(done => this.waiters.add(done));
  }
}
