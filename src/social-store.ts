import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageEvent, Segment } from './onebot.js';
import { segmentsToText } from './onebot.js';

const segment = z.object({ type: z.string(), data: z.record(z.unknown()) });
const message = z.object({ chat: z.string(), id: z.number().int().safe(), user: z.number().int().safe(), name: z.string(), at: z.number(), text: z.string(), segments: z.array(segment), self: z.boolean(), recalled: z.boolean().default(false) });
const contact = z.object({ chat: z.string(), name: z.string(), at: z.number() });
const memory = z.object({ id: z.string(), chat: z.string(), user: z.string(), name: z.string(), text: z.string(), at: z.number() });
const sticker = z.object({ id: z.string(), file: z.string(), note: z.string(), tags: z.array(z.string()), uses: z.number(), at: z.number() });
const task = z.object({ id: z.string(), chat: z.string(), creator: z.string(), text: z.string(), due: z.number(), interval: z.number().default(0), state: z.enum(['pending', 'running', 'sent', 'failed', 'unknown', 'cancelled']), error: z.string().default('') });
const event = z.object({ id: z.string(), chat: z.string(), type: z.string(), at: z.number(), data: z.record(z.unknown()), handled: z.boolean().default(false) });
const action = z.object({ id: z.string(), chat: z.string(), tool: z.string(), at: z.number(), state: z.enum(['running', 'success', 'failed', 'unknown']), summary: z.string() });
const turn = z.object({ id: z.string(), chat: z.string(), at: z.number(), duration: z.number(), input: z.string(), output: z.string(), tools: z.array(z.string()), error: z.string(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable() });
const profile = z.object({ chat: z.string().regex(/^(group|private):\d+$/), persona: z.string().max(10000), responseMode: z.enum(['inherit','mention','keywords','probability','all']).default('inherit'), keywords: z.array(z.string().max(64)).max(100).default([]), probability: z.number().int().min(0).max(100).default(10), proactive: z.boolean().default(true) });
const schema = z.object({ version: z.literal(1), account: z.number().int().default(0), messages: z.array(message), contacts: z.array(contact), memories: z.array(memory), stickers: z.array(sticker), tasks: z.array(task), events: z.array(event), actions: z.array(action), turns: z.array(turn), profiles: z.array(profile).default([]) });
export type SocialData = z.infer<typeof schema>;
export type StoredMessage = z.infer<typeof message>;
export type ScheduledTask = z.infer<typeof task>;

export class SocialStore {
  private data: SocialData = schema.parse({ version: 1, messages: [], contacts: [], memories: [], stickers: [], tasks: [], events: [], actions: [], turns: [] });
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  async load(): Promise<void> {
    try { this.data = schema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // A process crash during a send has an unknown outcome; never repeat it automatically.
    await this.update(d => {
      for (const item of d.actions) if (item.state === 'running') item.state = 'unknown';
      for (const item of d.tasks) if (item.state === 'running') { item.state = 'unknown'; item.error = '上次执行中断，请核对聊天记录后再安排'; }
    });
  }
  snapshot(): SocialData { return structuredClone(this.data); }
  profile(chat: string): SocialData['profiles'][number] | undefined { return structuredClone(this.data.profiles.find(p => p.chat === chat)); }
  memories(chat: string): SocialData['memories'] { return structuredClone(this.data.memories.filter(m => m.chat === chat)); }
  contacts(): SocialData['contacts'] { return structuredClone(this.data.contacts); }
  dueTasks(now: number): ScheduledTask[] { return structuredClone(this.data.tasks.filter(t => t.state === 'pending' && t.due <= now).slice(0,10)); }
  update<T>(fn: (draft: SocialData) => T): Promise<T> {
    const job = this.chain.then(async () => {
      const next = structuredClone(this.data);
      const result = fn(next);
      const validated = schema.parse(next);
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify(validated) + '\n', 'utf8');
      await rename(`${this.path}.tmp`, this.path);
      this.data = validated;
      return structuredClone(result);
    });
    this.chain = job.catch(() => undefined);
    return job;
  }
  flush(): Promise<unknown> { return this.chain; }
  async account(id: number): Promise<void> {
    if (this.data.account === id) return;
    if (this.data.account && this.data.account !== id) throw new Error('QQ 账号与社交数据不匹配，请为新账号指定独立数据文件');
    await this.update(d => { d.account = id; });
  }
  async record(event: MessageEvent, days: number, perChat: number): Promise<void> {
    const chat = event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id === event.self_id ? (event as unknown as { target_id?: number }).target_id ?? event.user_id : event.user_id}`;
    await this.add({ chat, id: event.message_id, user: event.user_id, name: event.sender.card || event.sender.nickname, at: event.time * 1000, text: segmentsToText(event.message), segments: event.message, self: event.user_id === event.self_id, recalled: false }, days, perChat);
  }
  async add(entry: StoredMessage, days = 30, perChat = 2000): Promise<void> {
    await this.update(d => {
      if (d.messages.some(m => m.chat === entry.chat && m.id === entry.id)) return;
      d.messages.push(entry);
      d.messages.sort((a,b) => a.at - b.at);
      const counts = new Map<string, number>();
      const cutoff = Date.now() - days * 86_400_000;
      d.messages = d.messages.filter(m => m.at >= cutoff).reverse().filter(m => {
        const n = (counts.get(m.chat) ?? 0) + 1; counts.set(m.chat, n); return n <= perChat;
      }).reverse().slice(-50000);
      const c = d.contacts.find(c => c.chat === entry.chat);
      if (c) c.at = Math.max(c.at, entry.at);
      else d.contacts.push({ chat: entry.chat, name: entry.chat.startsWith('private:') ? entry.name : entry.chat, at: entry.at });
      d.contacts = d.contacts.slice(-5000);
    });
  }
  messages(chat: string, limit = 30, offset = 0, query = ''): StoredMessage[] {
    const all = this.data.messages.filter(m => m.chat === chat && (!query || m.text.includes(query)));
    return structuredClone(all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset)));
  }
  message(chat: string, id: number): StoredMessage {
    const found = this.data.messages.find(m => m.chat === chat && m.id === id);
    if (!found) throw new Error('当前会话找不到该消息，请先查询近期消息，使用返回的真实消息编号');
    return structuredClone(found);
  }
  async sent(chat: string, user: number, id: number, segments: Segment[], name: string): Promise<void> {
    if (!Number.isSafeInteger(id)) throw new Error('发送返回缺少消息编号，结果未知，请勿自动重发');
    await this.add({ chat, id, user, name, at: Date.now(), text: segmentsToText(segments), segments, self: true, recalled: false });
  }
  async beginAction(chat: string, tool: string): Promise<string> {
    const id = randomUUID();
    await this.update(d => { d.actions.push({ id, chat, tool, at: Date.now(), state: 'running', summary: '' }); d.actions = d.actions.slice(-2000); });
    return id;
  }
  async endAction(id: string, state: 'success' | 'failed' | 'unknown', summary: string): Promise<void> {
    await this.update(d => { const a = d.actions.find(a => a.id === id); if (a) { a.state = state; a.summary = summary.slice(0, 2000); } });
  }
  async addEvent(chat: string, type: string, data: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    return this.update(d => {
      if (type.startsWith('request:') && typeof data.flag === 'string') { const old = d.events.find(e => e.chat === chat && e.type === type && e.data.flag === data.flag); if (old) return old.id; }
      d.events.push({ id, chat, type, at: Date.now(), data, handled: false }); d.events = d.events.slice(-1000); return id;
    });
  }
  async addTask(input: Omit<ScheduledTask, 'id' | 'state' | 'error'>): Promise<ScheduledTask> {
    return this.update(d => {
      if (d.tasks.filter(t => t.state === 'pending').length >= 500) throw new Error('待执行提醒已达 500 条');
      const item: ScheduledTask = { ...input, id: randomUUID(), state: 'pending', error: '' };
      d.tasks.push(item); d.tasks = d.tasks.filter(t => t.state === 'pending' || t.state === 'running').concat(d.tasks.filter(t => t.state !== 'pending' && t.state !== 'running').slice(-500));
      return item;
    });
  }
}
