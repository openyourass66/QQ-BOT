import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { MessageEvent } from './onebot.js';
import { segmentsToText, stripMention } from './onebot.js';
import type { BotSettings } from '../core/settings.js';

export const GroupContextEntrySchema = z.object({
  seq: z.number().int().positive().safe(),
  messageId: z.number().int().safe(),
  userId: z.number().int().nonnegative().safe(),
  name: z.string().max(128),
  text: z.string().max(2000),
  role: z.enum(['user', 'assistant']),
  at: z.number().finite(),
  replyTo: z.number().int().positive().safe().optional(),
  targetUserId: z.number().int().positive().safe().optional(),
});
export type GroupContextEntry = z.infer<typeof GroupContextEntrySchema>;
type Entry=GroupContextEntry;
export const GroupContextSchema = z.object({ version: z.literal(1), groups: z.record(z.string(), z.array(GroupContextEntrySchema).max(80)) });
const DAY = 86_400_000;

/** 按机器人账号和群隔离，保留最近一天、每群 80 条、最多 100 个群的对话。 */
export class GroupContextStore {
  protected groups = new Map<string, Entry[]>();
  protected seq = 0;
  private timer?: NodeJS.Timeout;
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;
  private persisted = 0;
  protected readonly path: string;

  constructor(path: string, protected readonly now: () => number = Date.now, protected readonly onError: (error: unknown) => void = () => undefined) {
    this.path = resolve(path);
  }

  async load(): Promise<void> {
    try {
      const file = GroupContextSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      for (const [key, entries] of Object.entries(file.groups).slice(-100)) {
        if (!/^\d+:\d+$/.test(key)) throw new Error('群上下文的账号或群号无效');
        for (const entry of entries) this.seq = Math.max(this.seq, entry.seq);
        this.groups.set(key, entries.filter((entry) => this.now() - entry.at < DAY));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  record(account: number, group: number, input: Omit<Entry, 'seq' | 'at'>): Entry {
    const key = `${account}:${group}`;
    const entries = (this.groups.get(key) ?? []).filter((entry) => this.now() - entry.at < DAY);
    const existing = entries.find((entry) => entry.messageId === input.messageId);
    const entry: Entry = existing ?? { ...input, seq: ++this.seq, at: this.now(), name: input.name.slice(0, 128), text: input.text.slice(0, 2000) };
    if (existing) {
      if (input.replyTo !== undefined) existing.replyTo = input.replyTo;
      if (input.targetUserId !== undefined) existing.targetUserId = input.targetUserId;
    } else entries.push(entry);
    this.groups.delete(key); this.groups.set(key, entries.slice(-80));
    const changed=[key];
    if (this.groups.size > 100) {const evicted=this.groups.keys().next().value!;this.groups.delete(evicted);changed.push(evicted);}
    this.changed(changed);
    return { ...entry };
  }

  protected changed(_keys:string[]):void {
    this.revision++;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(this.onError); }, 500);
      this.timer.unref();
    }
  }

  private entries(account: number, group: number): Entry[] {
    return (this.groups.get(`${account}:${group}`) ?? []).filter((entry) => this.now() - entry.at < DAY);
  }

  find(account: number, group: number, id: number): Entry | undefined {
    const entry = this.entries(account, group).find((item) => item.messageId === id);
    return entry ? { ...entry } : undefined;
  }

  context(account: number, group: number, current: number, lines: number): Entry[] {
    if (lines <= 0) return [];
    return this.entries(account, group).filter((entry) => entry.seq < current ||
      (entry.role === 'assistant' && entry.replyTo !== undefined && entry.replyTo < current))
      .slice(-lines).map((entry) => ({ ...entry }));
  }

  canFollowUp(account: number, group: number, user: number, windowMs: number): boolean {
    if (windowMs <= 0) return false;
    const last = this.entries(account, group).filter((entry) => entry.role === 'assistant').at(-1);
    return Boolean(last && last.targetUserId === user && this.now() - last.at <= windowMs);
  }

  hasReply(account: number, group: number, seq: number): boolean {
    return this.entries(account, group).some((entry) => entry.role === 'assistant' && entry.replyTo === seq);
  }

  clear(account: number, group: number): void {
    this.groups.delete(`${account}:${group}`);this.changed([`${account}:${group}`]);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const task = this.writes.then(async () => {
      if (this.persisted === this.revision) return;
      const revision = this.revision;
      const groups = [...this.groups].map(([key, entries]) => [key, entries.filter((entry) => this.now() - entry.at < DAY)] as const).filter(([, entries]) => entries.length > 0);
      const content = JSON.stringify({ version: 1, groups: Object.fromEntries(groups) });
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, `${content}\n`, 'utf8');
      // Windows readers may briefly hold the destination without delete sharing.
      for(let attempt=0;;attempt++) {
        try {await rename(`${this.path}.tmp`,this.path);break;}
        catch(error) {
          if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=5)throw error;
          await new Promise(resolve=>setTimeout(resolve,20*(attempt+1)));
        }
      }
      this.persisted = revision;
    });
    this.writes = task.catch(() => undefined);
    return task;
  }
}

export interface GroupTrigger { ok: boolean; body: string; direct: boolean; reason: string }

export function groupTrigger(event: MessageEvent, settings: BotSettings, memory: GroupContextStore, aliases: string[] = []): GroupTrigger {
  const account = event.self_id;
  const content = segmentsToText(event.message.filter((segment) => segment.type !== 'reply'));
  const body = segmentsToText(stripMention(event.message.filter((segment) => segment.type !== 'reply'), account));
  const result = (reason: string, text = body): GroupTrigger => ({ ok: true, body: text || '（对方 @ 了你，没有附带文字，请自然接一句。）', direct: true, reason });
  if (event.message.some((segment) => segment.type === 'at' && Number(segment.data.qq) === account)) return result('mention');
  const quoted = event.message.find((segment) => segment.type === 'reply');
  if (quoted && memory.find(account, event.group_id!, Number(quoted.data.id))?.role === 'assistant') return result('quote');
  const prefix = settings.chat.group.prefix;
  if (prefix && content.startsWith(prefix)) return result('prefix', content.slice(prefix.length).trim());
  for (const alias of new Set([settings.identity.name, ...aliases])) {
    if (alias.trim().length >= 2 && content.toLocaleLowerCase().startsWith(alias.trim().toLocaleLowerCase())) return result('name');
  }
  if (new RegExp(`@${account}(?!\\d)`).test(content)) return result('text-mention', content.replace(new RegExp(`@${account}(?!\\d)`, 'g'), '').trim());
  // 引用第三方或 @ 其他人时，不把对方的对话当作对机器人的追问。
  const directedElsewhere = quoted || event.message.some((segment) => segment.type === 'at');
  if (!directedElsewhere && memory.canFollowUp(account, event.group_id!, event.user_id, settings.chat.group.followUpMs) &&
    /[?？]|^(那|所以|然后|还有|但是|不过|为啥|为什么|怎么|如何|能不能|可以|比如|举个|继续|再说|什么意思|没懂|不对|不是|你|这个|那个|它|刚才)/.test(content)) return result('follow-up');
  return { ok: !settings.chat.group.requireMention, body: content, direct: false, reason: 'ambient' };
}

export function formatGroupEntry(entry: Pick<Entry, 'name' | 'userId' | 'text' | 'role'>): string {
  const name = entry.name.replace(/\s+/g, ' ') || String(entry.userId);
  return `${entry.role === 'assistant' ? '[你]' : '[群友]'} ${name}（QQ ${entry.userId}）: ${JSON.stringify(entry.text)}`;
}
