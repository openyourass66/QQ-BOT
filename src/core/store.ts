import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const SessionStoreSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), z.object({ sessionId: z.string().min(1), updatedAt: z.number().finite(), policy:z.string().optional(), generation:z.number().int().positive().optional() })),
});

type StoreShape = {
  version: 1;
  sessions: Record<string, { sessionId: string; updatedAt: number; policy?:string; generation?:number }>;
};

/**
 * QQ 会话 → DSH 会话 的映射。持久化后，桥接进程重启可以用 session/resume
 * 接回原来的上下文，而不是从零开始。
 */
export class SessionStore {
  protected data: StoreShape = { version: 1, sessions: {} };
  protected readonly path: string;
  private saving?: Promise<void>;
  private revision = 0;
  private persistedRevision = 0;

  constructor(path = 'data/sessions.json') {
    this.path = resolve(path);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      this.data = SessionStoreSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(key: string): string | undefined {
    return this.data.sessions[key]?.sessionId;
  }

  metadata(key:string) {return structuredClone(this.data.sessions[key]);}
  set(key: string, sessionId: string, policy?:string,generation?:number): void {
    this.data.sessions[key] = { sessionId, updatedAt: Date.now(),...(policy===undefined?{}:{policy}),...(generation===undefined?{}:{generation}) };
    this.changed(key);
  }

  delete(key: string): void {
    delete this.data.sessions[key];
    this.changed(key);
  }

  entries(): Array<[string, string]> {
    return Object.entries(this.data.sessions).map(([key, value]) => [key, value.sessionId]);
  }

  list(): Array<{ key: string; sessionId: string; updatedAt: number }> {
    return Object.entries(this.data.sessions).map(([key, value]) => ({
      key,
      sessionId: value.sessionId,
      updatedAt: value.updatedAt,
    }));
  }

  protected changed(_key:string): void {
    this.revision += 1;
    void this.flush().catch((error) => console.error('[store] 保存失败:', error));
  }

  flush(): Promise<void> {
    this.saving ??= (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      while (this.persistedRevision < this.revision) {
        const revision = this.revision;
        await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
        await rename(temp, this.path);
        this.persistedRevision = revision;
      }
    })().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }
}
