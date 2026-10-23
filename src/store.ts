import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type StoreShape = {
  version: 1;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
};

/**
 * QQ 会话 → DSH 会话 的映射。持久化后，桥接进程重启可以用 session/resume
 * 接回原来的上下文，而不是从零开始。
 */
export class SessionStore {
  private data: StoreShape = { version: 1, sessions: {} };
  private readonly path: string;
  private saving?: Promise<void>;

  constructor(path = 'data/sessions.json') {
    this.path = resolve(path);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as StoreShape;
      if (parsed?.version === 1 && parsed.sessions) this.data = parsed;
    } catch {
      // 首次启动没有文件是正常情况。
    }
  }

  get(key: string): string | undefined {
    return this.data.sessions[key]?.sessionId;
  }

  set(key: string, sessionId: string): void {
    this.data.sessions[key] = { sessionId, updatedAt: Date.now() };
    void this.save();
  }

  delete(key: string): void {
    delete this.data.sessions[key];
    void this.save();
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

  private save(): Promise<void> {
    this.saving ??= (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(temp, this.path);
    })().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }
}
