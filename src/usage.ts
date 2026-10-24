import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConversationQueue } from './runtime.js';

const UsageSchema = z.object({
  version: z.literal(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counters: z.record(z.number().int().nonnegative().safe()),
});

type Usage = z.infer<typeof UsageSchema>;
export type Quota = { key: string; amount: number; limit: number; label: string };

export function shanghaiDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** 由桥接进程统一写入；不同 MCP 子进程共享同一份额度。 */
export class DailyUsageStore {
  private readonly queue = new ConversationQueue();
  private data: Usage = { version: 1, date: '', counters: {} };
  private readonly path: string;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.path = resolve(path);
  }

  async load(): Promise<void> {
    try {
      this.data = UsageSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** 在远端动作前持久化预扣。远端失败或结果未知时不退回额度。 */
  consume(getQuotas: () => Quota[], onReserved: () => void = () => undefined): Promise<void> {
    return this.queue.run('usage', async () => {
      const date = shanghaiDate(this.now());
      const next: Usage = this.data.date === date
        ? structuredClone(this.data)
        : { version: 1, date, counters: {} };
      for (const quota of getQuotas()) {
        if (!Number.isSafeInteger(quota.amount) || quota.amount <= 0 ||
            !Number.isSafeInteger(quota.limit) || quota.limit < 0) {
          throw new Error('无效的额度参数');
        }
        const used = next.counters[quota.key] ?? 0;
        if (used > quota.limit - quota.amount) {
          throw new Error(`${quota.label}今日额度不足（已用 ${used}，上限 ${quota.limit}）`);
        }
        next.counters[quota.key] = used + quota.amount;
      }
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
      this.data = next;
      onReserved();
    });
  }

  async flush(): Promise<void> {
    await this.queue.drain();
  }
}
