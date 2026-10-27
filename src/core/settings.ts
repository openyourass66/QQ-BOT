import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { SocialSettingsSchema } from '../qq/social-settings.js';
import { LearningSettingsSchema, ContextSettingsSchema } from '../agent/intelligence-settings.js';

const GroupSchema = z
  .object({
    requireMention: z.boolean().default(true),
    prefix: z.string().max(32).default(config.bot.groupPrefix),
    cooldownMs: z.number().int().min(0).max(60000).default(config.bot.groupCooldownMs),
    contextLines: z.number().int().min(0).max(30).default(config.bot.groupContextLines),
    followUpMs: z.number().int().min(0).max(600000).default(90000),
    proactive: z
      .object({
        enabled: z.boolean().default(false),
        perGroupPerDay: z.number().int().min(0).max(20).default(1),
      })
      .prefault({}),
  })
  .prefault({});

const SettingsSchema = z
  .object({
    installation: z.object({ version: z.literal(1), scopeConfigured: z.boolean() }).optional(),
    learning: LearningSettingsSchema,
    context: ContextSettingsSchema,
    social: SocialSettingsSchema,
    identity: z
      .object({
        name: z.string().min(1).max(32).default('小深'),
      })
      .prefault({}),
    chat: z
      .object({
        privateAutoReply: z.boolean().default(true),
        group: GroupSchema,
        delay: z
          .object({
            minMs: z.number().int().min(0).max(10000).default(config.bot.minDelayMs),
            maxMs: z.number().int().min(0).max(20000).default(config.bot.maxDelayMs),
            chunkSize: z.number().int().min(100).max(4000).default(config.bot.chunkSize),
          })
          .prefault({}),
      })
      .prefault({}),
    approval: z
      .object({
        adminQq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(config.bot.adminQq),
        allowExec: z.boolean().default(config.bot.allowExec),
        timeoutMs: z.number().int().min(5000).max(600000).default(90000),
      })
      .prefault({}),
    features: z
      .object({
        qzone: z
          .object({
            enabled: z.boolean().default(false),
            dailyLimit: z.number().int().min(0).max(10).default(1),
            requireConfirm: z.boolean().default(true),
            browseEnabled: z.boolean().default(false),
            commentsEnabled: z.boolean().default(false),
            commentDailyLimit: z.number().int().min(0).max(50).default(5),
            commentRequireConfirm: z.boolean().default(true),
          })
          .prefault({}),
      })
      .prefault({}),
    budgets: z
      .object({
        proactiveMessagesPerDay: z.number().int().min(0).max(100).default(5),
        remindersPerDay: z.number().int().min(0).max(100).default(5),
        likesPerDay: z.number().int().min(0).max(200).default(20),
      })
      .prefault({}),
  })
  .prefault({})
  .refine(value=>value.context.warningPercent<value.context.rolloverPercent,{
    message:'会话更换比例应大于上下文提醒比例',path:['context','rolloverPercent'],
  })
  .refine((value) => value.chat.delay.minMs <= value.chat.delay.maxMs, {
    message: 'minMs 不能大于 maxMs',
    path: ['chat', 'delay'],
  });

export type BotSettings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: BotSettings = SettingsSchema.parse({});

/** 仅用于尚无配置文件的新实例；已有文件继续沿用原来的缺省语义。 */
export function createInitialSettings(): BotSettings {
  return SettingsSchema.parse({
    installation: { version: 1, scopeConfigured: false },
    approval: { allowExec: false },
    social: {
      allowAll: false, autonomy: 'sensitive', autonomousEnabled: false,
      autoCollectStickers: false, autoQzoneEnabled: false,
    },
  });
}

const path = resolve(process.env.BOT_SETTINGS_FILE || 'bot.config.json');
export const getSettingsPath = (): string => path;
let current: BotSettings = DEFAULT_SETTINGS;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<(next: BotSettings) => void>();

function clone(value: BotSettings): BotSettings {
  return structuredClone(value);
}

function notify(next: BotSettings): void {
  for (const listener of listeners) listener(clone(next));
}

export function getSettings(): BotSettings {
  return clone(current);
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    current = createInitialSettings();
    await persist(current);
  }
  return clone(current);
}

export async function readSettingsFile(file: string): Promise<BotSettings> {
  try { return validateSettings(JSON.parse(await readFile(resolve(file), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return createInitialSettings(); }
}

async function persist(next: BotSettings, file = path): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export function validateSettings(input: unknown): BotSettings {
  return SettingsSchema.parse(input);
}

export async function saveSettings(input: unknown): Promise<BotSettings> {
  return saveSettingsFile(path, input);
}

export async function saveSettingsFile(file: string, input: unknown): Promise<BotSettings> {
  file = resolve(file);
  const parsed = validateSettings(input);
  const task = writes.then(async () => {
    await persist(parsed, file);
    if (file === path) { current = parsed; notify(parsed); }
    return clone(parsed);
  });
  writes = task.catch(() => undefined);
  return task;
}

export async function flushSettings(): Promise<void> {
  await writes;
}

/** 监听外部编辑 bot.config.json，热更新到内存。 */
export function watchSettings(): () => void {
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename && filename.toString() !== basename(path)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const reload = writes.then(async () => {
          const raw = await readFile(path, 'utf8');
          const parsed = SettingsSchema.parse(JSON.parse(raw));
          current = parsed;
          notify(parsed);
          console.log('[settings] reloaded from file');
        });
        writes = reload.catch((error) => {
          console.warn(`[settings] 热加载失败，保留旧值: ${String(error)}`);
        });
      }, 100);
    });
    return () => { clearTimeout(timer); watcher.close(); };
  } catch {
    // 文件不存在时不阻塞启动。
    return () => undefined;
  }
}
