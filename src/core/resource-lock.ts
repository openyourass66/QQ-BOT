import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ResourceLockedError extends Error {
  readonly code = 'BOT_RESOURCE_LOCKED';
  constructor(label: string) {
    super(`数据资源正在使用（${label}），请先停止使用同一数据的机器人实例。`);
    this.name = 'ResourceLockedError';
  }
}

/** Resolve existing ancestors as well as existing files, including directory junctions. */
async function canonicalPath(input: string): Promise<string> {
  let current = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      const actual = join(await realpath(current), ...missing.reverse());
      return process.platform === 'win32' ? actual.toLowerCase() : actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export interface ResourceLease { release(): void }

/**
 * An exclusive SQLite transaction holds an OS file lock on a separate, empty file.
 * There is no PID timeout or stale-lock deletion; process exit releases the OS lock.
 * This protects local filesystem resources, including shared custom store paths.
 */
export async function acquireDataResources(
  resources: ReadonlyArray<{ path: string; label: string }>,
  signal?: AbortSignal,
): Promise<ResourceLease> {
  const resolved = new Map<string, string>();
  for (const resource of resources) {
    signal?.throwIfAborted();
    const entry = await lstat(resolve(resource.path)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink()) {
      const target = await stat(resource.path).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      // JSON's atomic rename replaces a file symlink and would change its lock identity.
      if (!target?.isDirectory()) throw new Error(`数据资源不支持文件或失效的符号链接（${resource.label}）`);
    }
    const path = await canonicalPath(resource.path);
    if (!resolved.has(path)) resolved.set(path, resource.label);
  }
  const held: DatabaseSync[] = [];
  const release = (): void => {
    for (const db of held.splice(0).reverse()) {
      try { db.close(); } catch { /* Closing an already closed handle is harmless. */ }
    }
  };
  try {
    for (const [path, label] of [...resolved].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      signal?.throwIfAborted();
      const info = await stat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (info?.isFile() && info.nlink > 1) throw new Error(`数据资源不支持硬链接（${label}）`);
      await mkdir(dirname(path), { recursive: true });
      const db = new DatabaseSync(`${path}.qqbot-lock.sqlite`);
      try {
        db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        held.push(db);
      } catch (error) {
        db.close();
        if ([5, 6].includes((error as { errcode?: number }).errcode ?? 0)) throw new ResourceLockedError(label);
        throw error;
      }
    }
    signal?.throwIfAborted();
    return { release };
  } catch (error) {
    release();
    throw error;
  }
}
