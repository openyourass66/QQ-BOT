import { readFile, rename, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const GroupSchema = z
  .object({
    requireMention: z.boolean().default(true),
    prefix: z.string().max(32).default(''),
    cooldownMs: z.number().int().min(0).max(60000).default(3000),
    contextLines: z.number().int().min(0).max(30).default(6),
    proactive: z
      .object({
        enabled: z.boolean().default(false),
        perGroupPerDay: z.number().int().min(0).max(20).default(1),
      })
      .default({}),
  })
  .default({});

const SettingsSchema = z
  .object({
    identity: z
      .object({
        name: z.string().min(1).max(32).default('小深'),
      })
      .default({}),
    chat: z
      .object({
        privateAutoReply: z.boolean().default(true),
        group: GroupSchema,
        delay: z
          .object({
            minMs: z.number().int().min(0).max(10000).default(700),
            maxMs: z.number().int().min(0).max(20000).default(2400),
            chunkSize: z.number().int().min(100).max(4000).default(600),
          })
          .default({}),
      })
      .default({}),
    approval: z
      .object({
        adminQq: z.number().int().min(0).default(0),
        allowExec: z.boolean().default(false),
        timeoutMs: z.number().int().min(5000).max(600000).default(90000),
      })
      .default({}),
    features: z
      .object({
        qzone: z
          .object({
            enabled: z.boolean().default(false),
            dailyLimit: z.number().int().min(0).max(10).default(1),
            requireConfirm: z.boolean().default(true),
          })
          .default({}),
        browsing: z
          .object({
            enabled: z.boolean().default(true),
            maxNavigations: z.number().int().min(1).max(10).default(3),
            maxScreenshots: z.number().int().min(0).max(5).default(2),
          })
          .default({}),
      })
      .default({}),
    budgets: z
      .object({
        proactiveMessagesPerDay: z.number().int().min(0).max(100).default(5),
        likesPerDay: z.number().int().min(0).max(200).default(20),
      })
      .default({}),
  })
  .default({});

export type BotSettings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: BotSettings = SettingsSchema.parse({});

const path = resolve(process.env.BOT_SETTINGS_FILE ?? 'bot.config.json');
let current: BotSettings = DEFAULT_SETTINGS;
const listeners = new Set<(next: BotSettings) => void>();

function clone(value: BotSettings): BotSettings {
  return structuredClone(value);
}

function notify(next: BotSettings): void {
  for (const listener of listeners) listener(clone(next));
}

export function getSettings(): BotSettings {
  return current;
}

export function onSettingsChange(listener: (next: BotSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadSettings(): Promise<BotSettings> {
  try {
    const raw = await readFile(path, 'utf8');
    current = SettingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[settings] 读取失败，使用默认值: ${String(error)}`);
    }
    current = clone(DEFAULT_SETTINGS);
    await persist(current);
  }
  return current;
}

async function persist(next: BotSettings): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export async function saveSettings(input: unknown): Promise<BotSettings> {
  const parsed = SettingsSchema.parse(input);
  current = parsed;
  await persist(parsed);
  notify(parsed);
  return parsed;
}

/** 监听外部编辑 bot.config.json，热更新到内存。 */
export function watchSettings(): void {
  try {
    watch(path, { persistent: false }, () => {
      void (async () => {
        try {
          const raw = await readFile(path, 'utf8');
          const parsed = SettingsSchema.parse(JSON.parse(raw));
          current = parsed;
          notify(parsed);
          console.log('[settings] reloaded from file');
        } catch (error) {
          console.warn(`[settings] 热加载失败，保留旧值: ${String(error)}`);
        }
      })();
    });
  } catch {
    // 文件不存在时不阻塞启动。
  }
}
