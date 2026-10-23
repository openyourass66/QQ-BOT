/** 同一会话的生成与发送串行执行；失败不阻塞后续任务。 */
export class ConversationQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  has(key: string): boolean {
    return this.chains.has(key);
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(task, task);
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
