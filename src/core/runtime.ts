export class QueueFullError extends Error {
  constructor() {
    super('消息队列已满');
    this.name = 'QueueFullError';
  }
}

/** 同一会话的生成与发送串行执行；失败不阻塞后续任务。 */
export class ConversationQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly counts = new Map<string, number>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private pending = 0;

  constructor(private readonly options: {
    maxPerKey?: number;
    maxTotal?: number;
    maxConcurrent?: number;
    onChange?: (pending: number) => void;
  } = {}) {
    for (const value of [options.maxPerKey, options.maxTotal, options.maxConcurrent]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error('队列容量必须是正整数');
      }
    }
  }

  get size(): number {
    return this.pending;
  }

  private async acquire(): Promise<void> {
    if (this.active < (this.options.maxConcurrent ?? Infinity)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  has(key: string): boolean {
    return this.chains.has(key);
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const count = this.counts.get(key) ?? 0;
    if (count >= (this.options.maxPerKey ?? Infinity) || this.pending >= (this.options.maxTotal ?? Infinity)) {
      return Promise.reject(new QueueFullError());
    }
    this.counts.set(key, count + 1);
    this.pending++;
    this.options.onChange?.(this.pending);
    const execute = async (): Promise<T> => {
      await this.acquire();
      try { return await task(); }
      finally { this.release(); }
    };
    const next = (this.chains.get(key) ?? Promise.resolve()).then(execute, execute).finally(() => {
      const remaining = this.counts.get(key)! - 1;
      if (remaining) this.counts.set(key, remaining);
      else this.counts.delete(key);
      this.pending--;
      this.options.onChange?.(this.pending);
    });
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  async drain(): Promise<void> {
    await Promise.all(this.chains.values());
  }
}

export async function withTimeout<T>(
  task: Promise<T>, ms: number, onTimeout: () => void = () => undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`操作超时 (${ms}ms)`));
          onTimeout();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
