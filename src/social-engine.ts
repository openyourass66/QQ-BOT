import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { SocialStore, type ScheduledTask } from './social-store.js';
import { MediaService } from './media.js';
import { socialTools, SocialCallSchema, type ToolContext } from './social-tools.js';
import { allowedChat } from './social-settings.js';
import type { BotSettings } from './settings.js';
import { OneBotHttp, parseMessageEvent, parseCqMessage, segmentsToText, type Segment } from './onebot.js';
import type { DailyUsageStore, Quota } from './usage.js';
import { StickerReviews, imageHash, stickerReviewPrompt, stickerSearchText, stickerInfo, type StickerAnalysis } from './sticker-review.js';
import { QqStickers } from './qq-stickers.js';

export class SocialEngine {
  private sending = new Map<string, Promise<unknown>>();
  private rates = new Map<string, number[]>();
  private contactsAt = 0;
  private friendIds = new Set<string>();
  private groupIds = new Set<string>();
  private posts = new Set<string>();
  private groupFiles = new Map<string, Map<string, Record<string, unknown>>>();
  private tickRunning = false;
  private proactiveAt = new Map<string, number>();
  private stickerReviews = new StickerReviews();
  readonly qqStickers: QqStickers;
  constructor(readonly store: SocialStore, readonly media: MediaService, private readonly api: OneBotHttp,
    private readonly usage: DailyUsageStore, private readonly settings: () => BotSettings,
    private readonly confirm: (title: string, signal: AbortSignal) => Promise<boolean>,
    private readonly onSent: (chat: string, id: number, segments: Segment[], source?: string) => void,
    private readonly log: (text: string) => void) { this.qqStickers=new QqStickers(store,media,api); }

  async contacts(signal: AbortSignal, force = false): Promise<void> {
    if (!force && Date.now() - this.contactsAt < 60000) return;
    const [friends, groups] = await Promise.all([
      this.api.call<Array<{ user_id: number; nickname: string; remark?: string }>>('get_friend_list', {}, signal),
      this.api.call<Array<{ group_id: number; group_name: string }>>('get_group_list', {}, signal),
    ]);
    if (!Array.isArray(friends) || !Array.isArray(groups)) throw new Error('协议端未返回有效好友/群列表，暂不能核验跨会话目标');
    const friendIds = new Set(friends.map(f => String(f.user_id))), groupIds = new Set(groups.map(g => String(g.group_id)));
    await this.store.update(d => {
      for (const c of [...friends.map(f => ({ chat: `private:${f.user_id}`, name: f.remark || f.nickname || String(f.user_id), at: 0 })), ...groups.map(g => ({ chat: `group:${g.group_id}`, name: g.group_name || String(g.group_id), at: 0 }))]) {
        const old = d.contacts.find(item => item.chat === c.chat); if (old) old.name = c.name; else d.contacts.push(c);
      }
      d.contacts = d.contacts.filter(c => (c.chat.startsWith('group:') ? groupIds : friendIds).has(c.chat.split(':')[1])).slice(-5000);
    });
    this.friendIds = friendIds; this.groupIds = groupIds; this.contactsAt = Date.now();
  }
  check(ctx: ToolContext, target = ctx.chat): void {
    ctx.signal.throwIfAborted();
    if (!allowedChat(this.settings().social, target, target === ctx.chat ? ctx.user : undefined)) throw new Error('该用户或会话已屏蔽或不在允许名单中');
  }
  async target(ctx: ToolContext, target: string): Promise<void> {
    this.check(ctx, target);
    if (target === ctx.chat) return;
    await this.contacts(ctx.signal);
    if (!(target.startsWith('group:') ? this.groupIds : this.friendIds).has(target.split(':')[1])) throw new Error('目标不是现有好友或已加入群，请先查询联系人');
  }
  async approve(ctx: ToolContext, tool: string, sensitive = false): Promise<void> {
    const mode = this.settings().social.autonomy;
    if ((mode === 'confirm' || (mode === 'sensitive' && sensitive)) && !await this.confirm(`QQ 操作：${tool}\n来源：${ctx.chat}`, ctx.signal)) throw new Error('操作未获确认');
    this.check(ctx);
  }
  actionQuotas(ctx: ToolContext, key = ctx.chat): Quota[] {
    this.check(ctx);
    const now = Date.now();
    const times = (this.rates.get(key) ?? []).filter(t => now - t < 60000);
    if (times.length >= this.settings().social.messagesPerMinute) throw new Error('当前会话操作过于频繁，请稍后再试');
    return [{ key: 'social-actions', amount: 1, limit: this.settings().social.actionsPerDay, label: 'QQ 动作' }];
  }
  recordAction(key: string): void {
    const now = Date.now();
    this.rates.set(key, [...(this.rates.get(key) ?? []).filter(t => now - t < 60000), now]);
    if (this.rates.size > 5000) this.rates.delete(this.rates.keys().next().value!);
  }
  private async quota(ctx: ToolContext, key: string, extra: Quota[] | (() => Quota[]) = []): Promise<void> {
    await this.usage.consume(() => [...this.actionQuotas(ctx, key), ...(typeof extra === 'function' ? extra() : extra)], () => this.recordAction(key));
  }
  private proactiveQuotas(ctx: ToolContext, target: string, proactive = false): Quota[] {
    if (!proactive && !ctx.proactive && target === ctx.chat) return [];
    const s = this.settings();
    const quotas: Quota[] = [{ key: 'proactive', amount: 1, limit: s.budgets.proactiveMessagesPerDay, label: '主动消息' }];
    if (target.startsWith('group:')) {
      if (!s.chat.group.proactive.enabled) throw new Error('群聊主动发言已关闭');
      quotas.push({ key: `group:${target.split(':')[1]}`, amount: 1, limit: s.chat.group.proactive.perGroupPerDay, label: '该群主动消息' });
    }
    return quotas;
  }
  private serial<T>(chat: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sending.get(chat) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.sending.set(chat, next);
    void next.finally(() => { if (this.sending.get(chat) === next) this.sending.delete(chat); }).catch(() => undefined);
    return next;
  }
  async send(ctx: ToolContext, segments: Segment[], target = ctx.chat, proactive = false): Promise<unknown> {
    return this.serial(target, async () => {
      await this.target(ctx, target);
      await this.quota(ctx, target, () => this.proactiveQuotas(ctx, target, proactive));
      this.check(ctx, target);
      const [kind, id] = target.split(':');
      const plain = segments.length === 1 && segments[0].type === 'text';
      let result: { message_id: number };
      try { result = await this.api.call<{ message_id: number }>(kind === 'group' ? 'send_group_msg' : 'send_private_msg', { [kind === 'group' ? 'group_id' : 'user_id']: Number(id), message: plain ? segments[0].data.text : segments, ...(plain ? { auto_escape: true } : {}) }, ctx.signal); }
      catch (error) { ctx.silent = true; throw error; }
      if (target === ctx.chat) ctx.sent++;
      await this.store.sent(target, ctx.self, result.message_id, segments, this.settings().identity.name);
      this.onSent(target, result.message_id, segments, ctx.chat);
      return { ...result, sent: true, target };
    });
  }
  async normalReply(ctx: ToolContext, text: string): Promise<unknown> {
    return this.send(ctx, [{ type: 'text', data: { text } }]);
  }
  private async decorators(ctx: ToolContext, args: Record<string, unknown>): Promise<Segment[]> {
    const parts: Segment[] = [];
    if (args.reply_to !== undefined) { this.message(ctx, Number(args.reply_to)); parts.push({ type: 'reply', data: { id: String(args.reply_to) } }); }
    if (args.at_user !== undefined) {
      if (!ctx.chat.startsWith('group:')) throw new Error('私聊不支持 @ 群成员');
      const members = await this.api.call<Array<{ user_id: number }>>('get_group_member_list', { group_id: Number(ctx.chat.split(':')[1]) }, ctx.signal);
      if (!Array.isArray(members) || !members.some(m => m.user_id === args.at_user)) throw new Error('@ 对象不是当前群成员');
      if (this.settings().social.blockedUsers.includes(String(args.at_user))) throw new Error('目标用户已屏蔽');
      parts.push({ type: 'at', data: { qq: String(args.at_user) } });
    }
    return parts;
  }
  private feature(name: 'memoryEnabled' | 'stickersEnabled' | 'mediaEnabled' | 'requestsEnabled' | 'filesEnabled' | 'remindersEnabled'): void {
    if (!this.settings().social[name]) throw new Error('该功能已关闭');
  }
  async execute(input: unknown, ctx: ToolContext): Promise<unknown> {
    this.check(ctx);
    const call = SocialCallSchema.parse(input);
    const tool = socialTools.find(t => t.name === call.tool);
    if (!tool) throw new Error('未知 QQ 工具');
    const args = z.object(tool.schema as z.ZodRawShape).strict().parse(call.args) as Record<string, any>;
    const reads = new Set(['qq_capabilities', 'qq_recent_messages', 'qq_message', 'qq_read_forward', 'qq_active_members', 'qq_chats', 'qq_images', 'qq_stickers', 'qq_sticker_image', 'qq_memory_query', 'qq_reminders', 'qq_events', 'qq_transcribe', 'qq_video', 'qq_file', 'qq_event_file', 'qq_group_files', 'qq_search', 'qq_qzone_feed', 'qq_finish', 'qq_report']);
    const collectPreview = call.tool === 'qq_collect_sticker' && !args.analysis_token;
    const sendSticker = call.tool === 'qq_send_sticker' ? this.store.snapshot().stickers.find(s => s.id === args.sticker_id) : undefined;
    if (sendSticker?.analysis?.confidence === 'low') throw new Error('这张表情含义尚不确定，请结合上下文重新看图分析，或选择其他已理解的表情');
    const sendPreview = call.tool === 'qq_send_sticker' && !sendSticker?.analysis;
    const mutates = !reads.has(call.tool) && !['qq_group_file','qq_actions'].includes(call.tool) && !(call.tool === 'qq_send_image' && args.preview) && !collectPreview && !sendPreview;
    const actionId = mutates ? await this.store.beginAction(ctx.chat, call.tool) : undefined;
    try {
      if (mutates) await this.approve(ctx, call.tool, ['qq_handle_request', 'qq_qzone_comment'].includes(call.tool));
      const result = await this.perform(call.tool, args, ctx);
      if (actionId) await this.store.endAction(actionId, 'success', `${tool.title}：${String(args.text ?? args.name ?? args.note ?? '已完成')}`);
      return result;
    } catch (e) {
      if (actionId) await this.store.endAction(actionId, 'unknown', String(e));
      throw e;
    }
  }
  private async perform(tool: string, a: Record<string, any>, ctx: ToolContext): Promise<unknown> {
    if(['qq_stickers','qq_sticker_note'].includes(tool)) { this.feature('stickersEnabled');await this.qqStickers.sync(ctx.signal); }
    const state = () => this.store.snapshot();
    switch (tool) {
      case 'qq_capabilities': return { media: this.media.capabilities(), settings: this.settings().social, tools: socialTools.map(t => ({ name: t.name, description: t.description })), notes: ['消息、成员必须使用真实编号', '本地记录仅包含已收到或主动拉取的消息', '接口成功不等于接收者已阅读'] };
      case 'qq_reply': {
        if (!a.text) throw new Error('文字不能为空；只想潜水请调用 qq_finish');
        return this.send(ctx, [...await this.decorators(ctx, a), { type: 'text', data: { text: a.text } }]);
      }
      case 'qq_recent_messages': {
        if (a.refresh) {
          const [kind, id] = ctx.chat.split(':');
          const result = await this.api.call<{ messages: unknown[] }>(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', { [kind === 'group' ? 'group_id' : 'user_id']: Number(id), count: a.limit, message_seq: 0 }, ctx.signal);
          if (!Array.isArray(result.messages)) throw new Error('协议端不支持历史查询或返回格式异常');
          for (const raw of result.messages) {
            const entry = raw as Record<string, unknown>;
            const ev = parseMessageEvent({ ...entry, post_type: 'message', message_type: kind, self_id: ctx.self, ...(kind === 'group' ? { group_id: Number(id) } : {}), sender: entry.sender ?? {} });
            if (ev && !this.settings().social.blockedUsers.includes(String(ev.user_id))) {
              await this.store.add({ chat: ctx.chat, id: ev.message_id, user: ev.user_id, name: ev.sender.card || ev.sender.nickname, at: ev.time * 1000, text: segmentsToText(ev.message), segments: ev.message, self: ev.user_id === ctx.self, recalled: false });
            }
          }
        }
        return this.store.messages(ctx.chat, a.limit, a.offset, a.query).filter(m => !this.settings().social.blockedUsers.includes(String(m.user)));
      }
      case 'qq_message': return this.message(ctx, a.message_id);
      case 'qq_read_forward': {
        const entry = this.message(ctx, a.message_id);
        const segment = entry.segments.find(s => s.type === 'forward');
        if (!segment) throw new Error('该消息不是合并转发');
        const result = await this.api.call<Record<string, unknown>>('get_forward_msg', { message_id: String(segment.data.id ?? a.message_id) }, ctx.signal);
        const media: Segment[] = [];
        const walk = (value: unknown, depth = 0): void => {
          if (!value || depth > 5 || media.length > 30) return;
          if (Array.isArray(value)) { for (const node of value.slice(0,100)) walk(node, depth+1); return; }
          if (typeof value !== 'object') return;
          const node = value as Record<string, unknown>;
          if (['image','record','video','file'].includes(String(node.type)) && node.data && typeof node.data === 'object') media.push(node as unknown as Segment);
          for (const key of ['content','message','messages','data']) if (node[key] && node[key] !== value) walk(node[key], depth+1);
        };
        walk(result);
        if (media.length) await this.store.update(d => { const original = d.messages.find(m => m.chat === ctx.chat && m.id === a.message_id); if (original) original.segments = original.segments.filter(s => s.type === 'forward').concat(media); });
        return result;
      }
      case 'qq_active_members': {
        const members = new Map<number, { user_id: number; name: string; last_at: number; count: number }>();
        for (const m of this.store.messages(ctx.chat, 2000)) {
          if (this.settings().social.blockedUsers.includes(String(m.user))) continue;
          const old = members.get(m.user); members.set(m.user, { user_id: m.user, name: m.name, last_at: Math.max(old?.last_at ?? 0, m.at), count: (old?.count ?? 0) + 1 });
        }
        return [...members.values()].sort((x,y) => y.last_at - x.last_at).slice(0, a.limit);
      }
      case 'qq_chats': {
        await this.contacts(ctx.signal, true);
        return state().contacts.filter(c => allowedChat(this.settings().social, c.chat) && `${c.name} ${c.chat}`.includes(a.query)).sort((x,y) => y.at - x.at).slice(0, a.limit);
      }
      case 'qq_poke': {
        const [kind, id] = ctx.chat.split(':'); const target = a.user_id ?? (kind === 'private' ? Number(id) : undefined);
        if (kind === 'private' && target !== Number(id)) throw new Error('私聊戳一戳只能操作当前私聊对象');
        if (!target || this.settings().social.blockedUsers.includes(String(target))) throw new Error('请指定当前群里未屏蔽的成员');
        if (kind === 'group') await this.decorators(ctx, { at_user: target });
        await this.quota(ctx, ctx.chat);
        return this.api.call(kind === 'group' ? 'group_poke' : 'friend_poke', { ...(kind === 'group' ? { group_id: Number(id) } : {}), user_id: target }, ctx.signal);
      }
      case 'qq_images': {
        this.feature('mediaEnabled'); const entry = this.message(ctx, a.message_id);
        const sources = entry.segments.filter(s => s.type === 'image').slice(0, 4);
        if (!sources.length) throw new Error('该消息没有图片');
        const images = [];
        for (const s of sources) images.push(await this.messageImage(s, ctx));
        return this.media.vision(images, a.question, ctx.signal);
      }
      case 'qq_send_image': {
        this.feature('mediaEnabled');
        const image = await this.media.image(a.source, ctx.signal);
        if (a.preview) return { content: [image] };
        const file = await this.media.save(Buffer.from(image.data, 'base64'), '.' + image.mimeType.split('/')[1]);
        return this.send(ctx, [...await this.decorators(ctx, a), ...(a.note ? [{ type: 'text', data: { text: a.note } }] : []), { type: 'image', data: { file: toFile(file) } }]);
      }
      case 'qq_stickers': {
        this.feature('stickersEnabled');
        const terms = a.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
        const score = (s: ReturnType<typeof state>['stickers'][number]) => s.analysis ? { high:3,medium:2,low:1 }[s.analysis.confidence] : 0;
        return state().stickers.filter(s => s.qqPresent && terms.every((term: string) => stickerSearchText(s).includes(term)))
          .sort((x,y) => score(y) - score(x)).slice(0, a.limit)
          .map(stickerInfo);
      }
      case 'qq_collect_sticker': {
        this.feature('stickersEnabled'); const entry = this.message(ctx, a.message_id);
        const segment = entry.segments.find(s => s.type === 'image'); if (!segment) throw new Error('该消息没有图片');
        if (Boolean(a.analysis_token) !== Boolean(a.analysis)) throw new Error('收藏必须先取得原图分析凭证，再提交完整 analysis，不能只提交备注');
        if (!a.analysis_token) {
          await this.qqStickers.sync(ctx.signal);
          const image = await this.messageImage(segment, ctx), hash = imageHash(Buffer.from(image.data, 'base64'));
          const existing = state().stickers.find(s => s.qqPresent && s.analysis?.imageHash === hash && s.analysis.confidence !== 'low');
          if (existing) { ctx.pendingStickerCollections?.delete(hash); return { ...stickerInfo(existing), collected: true, reused: true }; }
          return this.prepareStickerReview(ctx, { messageId: a.message_id }, image, a.note, 'collect');
        }
        return this.serial('sticker-review:' + a.analysis_token, async () => {
          const review = await this.checkedStickerReview(ctx, a.analysis_token, { messageId: a.message_id });
          const analysis: StickerAnalysis = { ...a.analysis, imageHash: review.hash, at: Date.now() };
          const favorite=await this.qqStickers.collect(review.file,ctx.signal,()=>this.quota(ctx,ctx.chat));
          const result = await this.store.update(d => {
            const existing = d.stickers.find(s => s.id===favorite.id);
            const note = a.note ?? analysis.meaning, tags = [...new Set<string>([...analysis.tags, ...(a.tags ?? [])])].slice(0,20);
            if (!existing) throw new Error('QQ 收藏记录已变化，请刷新后核对');
            existing.note = note; existing.tags = tags; existing.analysis = analysis; return existing;
          });
          this.stickerReviews.complete(a.analysis_token);
          ctx.pendingStickerCollections?.delete(review.hash);
          return { ...stickerInfo(result), collected: true };
        });
      }
      case 'qq_sticker_note': {
        this.feature('stickersEnabled');
        if (Boolean(a.analysis_token) !== Boolean(a.analysis)) throw new Error('更新理解必须先调用 qq_sticker_image 看原图，再提交分析凭证与 analysis');
        if (!a.analysis_token && a.note === undefined && a.tags === undefined) throw new Error('请填写备注、标签或完整的图片分析');
        return this.serial('sticker-review:' + (a.analysis_token ?? a.sticker_id), async () => {
          const review = a.analysis_token ? await this.checkedStickerReview(ctx, a.analysis_token, { stickerId: a.sticker_id }) : undefined;
          const result = await this.store.update(d => {
            const s = d.stickers.find(s => s.id === a.sticker_id); if (!s) throw new Error('表情不存在');
            if (review) {
              if (s.file !== review.file) throw new Error('表情图片已变更，请重新看图分析');
              const analysis: StickerAnalysis = { ...a.analysis, imageHash: review.hash, at: Date.now() };
              s.analysis = analysis;
              s.note = a.note ?? (s.note || analysis.meaning);
              s.tags = [...new Set<string>([...analysis.tags, ...(a.tags ?? s.tags)])].slice(0,20);
            } else { if (a.note !== undefined) s.note = a.note; if (a.tags !== undefined) s.tags = a.tags; }
            return s;
          });
          if (a.analysis_token) this.stickerReviews.complete(a.analysis_token);
          return stickerInfo(result);
        });
      }
      case 'qq_sticker_image':
      case 'qq_send_sticker': {
        this.feature('stickersEnabled');if(!state().stickers.some(s=>s.id===a.sticker_id))throw new Error('表情不存在');
        const image = await this.qqStickers.image(a.sticker_id, ctx.signal),s=state().stickers.find(s=>s.id===a.sticker_id);if(!s?.qqPresent)throw new Error('表情已从 QQ 收藏移除');
        if (tool === 'qq_sticker_image' || !s.analysis) return this.prepareStickerReview(ctx, { stickerId: s.id }, image, s.note, tool === 'qq_send_sticker' ? 'send' : 'view');
        if (imageHash(Buffer.from(image.data, 'base64')) !== s.analysis.imageHash) throw new Error('表情图片与理解记录不一致，请先用 qq_sticker_image 重新分析');
        if (s.analysis.confidence === 'low') throw new Error('这张表情含义尚不确定，请结合上下文重新看图分析，或选择其他已理解的表情');
        const result = await this.send(ctx, [...await this.decorators(ctx, a), { type: 'image', data: { file: toFile(s.file) } }]);
        ctx.pendingStickerSends?.delete(s.id);
        await this.store.update(d => { const s = d.stickers.find(s => s.id === a.sticker_id); if (s) s.uses++; }); return result;
      }
      case 'qq_memory_append': {
        this.feature('memoryEnabled');
        if (this.settings().social.blockedUsers.includes(String(a.user_id))) throw new Error('目标用户已屏蔽');
        return this.store.update(d => {
          const old = d.memories.find(m => m.chat === ctx.chat && m.user === String(a.user_id) && m.text === a.text); if (old) return old;
          if (d.memories.length >= 10000) throw new Error('长期记忆已满，请整理或删除旧记忆');
          const m = { id: randomUUID(), chat: ctx.chat, user: String(a.user_id), name: a.name, text: a.text, at: Date.now() }; d.memories.push(m); return m;
        });
      }
      case 'qq_memory_query': this.feature('memoryEnabled'); return state().memories.filter(m => m.chat === ctx.chat && (!a.user_id || m.user === String(a.user_id)) && `${m.name} ${m.text}`.includes(a.query) && !this.settings().social.blockedUsers.includes(m.user)).slice(-100);
      case 'qq_memory_remove': this.feature('memoryEnabled'); return this.store.update(d => { const before = d.memories.length; d.memories = d.memories.filter(m => !(m.chat === ctx.chat && m.id === a.memory_id)); return { removed: before - d.memories.length }; });
      case 'qq_finish': ctx.silent = true; ctx.topic = a.active_topic; ctx.endTopic = a.end_topic; this.log(`[decision] ${ctx.chat} ${a.reason}`); return { finished: true };
      case 'qq_set_reminder': {
        this.feature('remindersEnabled');
        if ((a.delay_minutes !== undefined) === (a.at_time !== undefined)) throw new Error('delay_minutes 与 at_time 必须且只能提供一项');
        const due = a.delay_minutes !== undefined ? Date.now() + a.delay_minutes * 60000 : parseShanghaiTime(a.at_time);
        if (!Number.isFinite(due) || due <= Date.now()) throw new Error('提醒时间必须在未来，格式为上海时间 YYYY-MM-DD HH:mm');
        return this.store.addTask({ chat: ctx.chat, creator: String(ctx.user), text: a.text, due, interval: a.interval_minutes * 60000 });
      }
      case 'qq_reminders': return state().tasks.filter(t => t.chat === ctx.chat && !['sent', 'cancelled'].includes(t.state));
      case 'qq_cancel_reminder': return this.store.update(d => { const task = d.tasks.find(t => t.id === a.reminder_id && t.chat === ctx.chat); if (!task || task.state !== 'pending') throw new Error('该提醒不存在或已开始执行'); task.state = 'cancelled'; return task; });
      case 'qq_events': return state().events.filter(e => e.chat === ctx.chat && (!a.pending_only || !e.handled)).slice(-50);
      case 'qq_actions': return state().actions.filter(action => action.chat === ctx.chat).slice(-30);
      case 'qq_handle_request': {
        this.feature('requestsEnabled'); const event = state().events.find(e => e.id === a.event_id && e.chat === ctx.chat && e.type.startsWith('request:'));
        if (!event || event.handled || typeof event.data.flag !== 'string') throw new Error('申请不存在或已经处理');
        await this.quota(ctx, ctx.chat);
        await this.store.update(d => { const e = d.events.find(e => e.id === event.id); if (!e || e.handled) throw new Error('申请已由其他操作处理'); e.handled = true; });
        return this.api.call(event.type === 'request:friend' ? 'set_friend_add_request' : 'set_group_add_request', { flag: event.data.flag, approve: a.approve, ...(event.type === 'request:friend' ? { remark: a.remark } : { sub_type: event.data.sub_type, reason: a.remark }) }, ctx.signal);
      }
      case 'qq_transcribe': this.feature('mediaEnabled'); return this.media.transcribe(await this.messageSource(ctx, a.message_id, 'record'), ctx.signal);
      case 'qq_speak': {
        this.feature('mediaEnabled'); const file = await this.media.speech(a.text, ctx.signal);
        return this.send(ctx, [{ type: 'record', data: { file: toFile(file) } }]);
      }
      case 'qq_video': this.feature('mediaEnabled'); return this.media.video(await this.messageSource(ctx, a.message_id, 'video'), a.question, ctx.signal);
      case 'qq_file': {
        this.feature('filesEnabled'); const entry = this.message(ctx, a.message_id); const segment = entry.segments.find(s => s.type === 'file'); if (!segment) throw new Error('该消息没有文件');
        const { buffer } = await this.media.bytes(await this.source(segment, ctx), ctx.signal, 25_000_000);
        const extension = extname(String(segment.data.name ?? '')).toLowerCase();
        const file = await this.media.save(buffer, /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin');
        return { file, bytes: buffer.length, name: segment.data.name, text: ['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html'].includes(extension) ? buffer.toString('utf8').slice(0, 30000) : undefined, note: '二进制文档尚未提取正文，可使用 DSH 已配置的文档读取能力' };
      }
      case 'qq_event_file': {
        this.feature('filesEnabled');
        const event = state().events.find(e => e.chat === ctx.chat && e.id === a.event_id && e.type.includes('upload'));
        if (!event || !event.data.file || typeof event.data.file !== 'object') throw new Error('上传事件不存在或没有文件信息');
        const fileInfo = event.data.file as Record<string, unknown>;
        const segment: Segment = { type:'file', data:{ ...fileInfo, file_id:fileInfo.id ?? fileInfo.file_id } };
        const { buffer } = await this.media.bytes(await this.source(segment,ctx),ctx.signal,25_000_000);
        const ext = extname(String(fileInfo.name ?? '')).toLowerCase();
        const file = await this.media.save(buffer,/^\.[a-z0-9]{1,8}$/.test(ext)?ext:'.bin');
        return { file,name:fileInfo.name,bytes:buffer.length,text:['.txt','.md','.csv','.json'].includes(ext)?buffer.toString('utf8').slice(0,30000):undefined };
      }
      case 'qq_group_files': {
        this.feature('filesEnabled'); if (!ctx.chat.startsWith('group:')) throw new Error('当前不是群聊');
        const result = await this.api.call<{files?:Array<Record<string, unknown>>}>(a.folder_id?'get_group_files_by_folder':'get_group_root_files',{group_id:Number(ctx.chat.split(':')[1]),...(a.folder_id?{folder_id:a.folder_id}:{})},ctx.signal);
        this.groupFiles.set(ctx.chat,new Map((result.files??[]).slice(0,1000).map(f=>[String(f.file_id),f])));
        if(this.groupFiles.size>100) this.groupFiles.delete(this.groupFiles.keys().next().value!);
        return result;
      }
      case 'qq_group_file': {
        this.feature('filesEnabled'); const info=this.groupFiles.get(ctx.chat)?.get(a.file_id); if(!info) throw new Error('请先浏览当前群文件，使用返回的真实文件编号');
        const source=await this.source({type:'file',data:info},ctx);
        const {buffer}=await this.media.bytes(source,ctx.signal,25_000_000);
        const extension=extname(String(info.file_name??info.name??'')).toLowerCase();
        const file=await this.media.save(buffer,/^\.[a-z0-9]{1,8}$/.test(extension)?extension:'.bin');
        return {file,name:info.file_name??info.name,bytes:buffer.length,text:['.txt','.md','.csv','.json'].includes(extension)?buffer.toString('utf8').slice(0,30000):undefined};
      }
      case 'qq_create_file': {
        this.feature('filesEnabled'); return { file:await this.media.save(Buffer.from(a.text,'utf8'),extname(a.name).toLowerCase()),name:a.name };
      }
      case 'qq_send_file': {
        this.feature('filesEnabled'); const { buffer } = await this.media.bytes(a.source, ctx.signal, 25_000_000);
        const file = await this.media.save(buffer, extname(a.name).replace(/[^.a-zA-Z0-9]/g,'').slice(0,10) || '.bin');
        return this.serial(ctx.chat, async () => {
          await this.quota(ctx, ctx.chat, () => this.proactiveQuotas(ctx, ctx.chat));
          const [kind, id] = ctx.chat.split(':');
          let result;
          try { result = await this.api.call(kind === 'group' ? 'upload_group_file' : 'upload_private_file', { [kind === 'group' ? 'group_id' : 'user_id']: Number(id), file, name: a.name }, ctx.signal); }
          catch (error) { ctx.silent = true; throw error; }
          ctx.sent++; this.onSent(ctx.chat, 0, [{ type: 'file', data: { name: a.name } }]); return result;
        });
      }
      case 'qq_search': {
        if (!process.env.BOT_SEARCH_URL) throw new Error('QQ 搜索服务未配置，请使用 DSH 已有搜索工具；或在连接配置中填写搜索适配服务');
        return adapter(process.env.BOT_SEARCH_URL, process.env.BOT_SEARCH_API_KEY, { query: a.query, images: a.images }, ctx.signal);
      }
      case 'qq_qzone_feed': {
        if (!process.env.BOT_QZONE_ADAPTER_URL) throw new Error('空间浏览适配服务未配置');
        if (a.user_id && this.settings().social.blockedUsers.includes(String(a.user_id))) throw new Error('目标用户已屏蔽');
        const result = await adapter(process.env.BOT_QZONE_ADAPTER_URL, process.env.BOT_QZONE_ADAPTER_TOKEN, { action: 'feed', ...a }, ctx.signal) as { posts?: Array<{ id: string }> };
        for (const post of result.posts ?? []) this.posts.add(String(post.id));
        if (this.posts.size > 1000) this.posts = new Set([...this.posts].slice(-1000));
        return result;
      }
      case 'qq_qzone_comment': {
        if (!process.env.BOT_QZONE_ADAPTER_URL) throw new Error('空间评论适配服务未配置');
        if (!this.settings().features.qzone.enabled) throw new Error('QQ 空间功能已关闭');
        if (!this.posts.has(a.post_id)) throw new Error('请先浏览空间，选择真实返回的动态 ID');
        await this.quota(ctx, ctx.chat, [{ key: 'qzone-comments', amount: 1, limit: this.settings().features.qzone.dailyLimit, label: '空间评论' }]);
        return adapter(process.env.BOT_QZONE_ADAPTER_URL, process.env.BOT_QZONE_ADAPTER_TOKEN, { action: 'comment', ...a }, ctx.signal);
      }
      case 'qq_report': this.log(`[report] ${ctx.chat} ${a.text}`); return { recorded: true };
      default: throw new Error('工具尚未实现');
    }
  }
  private async messageSource(ctx: ToolContext, id: number, type: string): Promise<string> {
    const s = this.message(ctx, id).segments.find(s => s.type === type); if (!s) throw new Error('该消息没有所需媒体');
    return this.source(s, ctx);
  }
  private message(ctx: ToolContext, id: number) {
    const message = this.store.message(ctx.chat, id);
    if (this.settings().social.blockedUsers.includes(String(message.user))) throw new Error('该消息的发送者已屏蔽，不能读取或引用');
    return message;
  }
  private async prepareStickerReview(ctx: ToolContext, target: { messageId?: number; stickerId?: string }, image: { type: 'image'; data: string; mimeType: string }, oldNote?: string, intent: 'collect' | 'send' | 'view' = 'view') {
    const buffer = Buffer.from(image.data, 'base64'), hash = imageHash(buffer);
    const existing = target.stickerId ? this.store.snapshot().stickers.find(s => s.id === target.stickerId) : undefined;
    const file = existing?.file ?? await this.media.save(buffer, '.' + image.mimeType.split('/')[1]);
    const visual = await this.media.vision([image], stickerReviewPrompt, ctx.signal) as { content?: any[]; text?: string };
    if (!visual || (!visual.content?.some(c => c.type === 'image' && c.data) && !(typeof visual.text === 'string' && visual.text.trim()))) throw new Error('未取得可用的原图或视觉分析，尚未完成收藏');
    this.check(ctx); this.feature('stickersEnabled');
    if (target.messageId !== undefined) this.message(ctx, target.messageId);
    const token = this.stickerReviews.issue({ chat: ctx.chat, user: ctx.user, ...target }, file, hash);
    if (intent === 'collect') ctx.pendingStickerCollections?.add(hash);
    if (intent === 'send' && target.stickerId) ctx.pendingStickerSends?.add(target.stickerId);
    const status = { status: 'needs_analysis', collected: target.stickerId !== undefined, sent: false, analysis_token: token, ...(target.messageId !== undefined ? { message_id: target.messageId } : { sticker_id: target.stickerId }), next_tool: target.messageId !== undefined ? 'qq_collect_sticker' : 'qq_sticker_note', expires_in_seconds: 300,
      instruction: stickerReviewPrompt + ' 当前仅提供分析材料，尚未完成理解，也没有发送。新收藏将在完成分析后入库。请提交与本次原图对应的完整 analysis 及 analysis_token；不能用旧备注代替看图。', ...(oldNote ? { old_note_as_reference_only: oldNote } : {}) };
    return { ...status, content: [{ type: 'text', text: JSON.stringify(status) }, ...(visual.content ?? [{ type: 'text', text: '独立视觉服务提供的分析材料：\n' + visual.text }])] };
  }
  private async checkedStickerReview(ctx: ToolContext, token: string, target: { messageId?: number; stickerId?: string }) {
    this.check(ctx); this.feature('stickersEnabled');
    const review = this.stickerReviews.require(token, { chat: ctx.chat, user: ctx.user, ...target });
    const { buffer } = await this.media.bytes(review.file, ctx.signal);
    if (imageHash(buffer) !== review.hash) throw new Error('分析原图已变更，请重新获取图片并分析');
    this.check(ctx);
    if (target.messageId !== undefined) this.message(ctx, target.messageId);
    return review;
  }
  private async messageImage(segment: Segment, ctx: ToolContext): Promise<{ type: 'image'; data: string; mimeType: string }> {
    let failure: unknown;
    for (const source of [segment.data.url, segment.data.file]) {
      if (typeof source !== 'string' || !/^(?:https?:|file:|[A-Za-z]:[\\/]|\/)/i.test(source)) continue;
      try { return await this.media.image(source, ctx.signal); }
      catch (error) { ctx.signal.throwIfAborted(); failure = error; }
    }
    const reference = segment.data.file_id ?? segment.data.file;
    if (typeof reference !== 'string' || !reference || reference.length > 8192 || /^(?:[a-z][\w+.-]*:|[\\/])/i.test(reference)) {
      throw failure ?? new Error('该图片缺少有效的协议文件编号');
    }
    let result: { file?: unknown; url?: unknown; base64?: unknown };
    try { result = await this.api.call('get_image', { file: reference }, ctx.signal); }
    catch (error) {
      ctx.signal.throwIfAborted();
      throw new Error(`图片直链不可用，协议端缓存获取失败：${error instanceof Error ? error.message : String(error)}。若 NapCat 已重启或图片已过期，请重新发送图片。`);
    }
    return this.media.onebotImage(result, ctx.signal, this.api.hasLocalMedia === true);
  }
  private async source(s: Segment, ctx: ToolContext): Promise<string> {
    const reference = s.data.file_id ?? s.data.file;
    if (s.type === 'record' && typeof reference === 'string' && !/^(?:https?:|file:|[A-Za-z]:[\\/]|\/)/.test(reference)) {
      const result = await this.api.call<{ url?: string; file?: string }>('get_record', { file: reference, out_format: 'wav' }, ctx.signal);
      if (!result.file && !result.url) throw new Error('协议端未返回可读取的转码语音');
      return result.file ?? result.url!;
    }
    if (typeof s.data.url === 'string' && /^https?:/.test(s.data.url)) return s.data.url;
    if (typeof s.data.file === 'string' && /^(?:https?:|file:|[A-Za-z]:[\\/]|\/)/.test(s.data.file)) return s.data.file;
    if (s.type === 'file' && s.data.file_id) {
      const [kind,id] = ctx.chat.split(':');
      const result = await this.api.call<{url?:string;file?:string}>(kind === 'group'?'get_group_file_url':'get_private_file_url',{...(kind==='group'?{group_id:Number(id),busid:s.data.busid??s.data.busi_id??102}:{user_id:Number(id)}),file_id:s.data.file_id},ctx.signal);
      if (!result.url && !result.file) throw new Error('协议端未返回文件地址');
      return result.url ?? result.file!;
    }
    const action = { image: 'get_image', record: 'get_record', video: 'get_file', file: 'get_file' }[s.type];
    if (!action) throw new Error('媒体无法定位');
    const result = await this.api.call<{ url?: string; file?: string }>(action, { file: s.data.file ?? s.data.file_id, file_id: s.data.file_id, out_format: 'wav' }, ctx.signal);
    const source = result.url ?? result.file;
    if (!source) throw new Error('协议端未返回可读取的媒体地址');
    return source;
  }
  async legacy(tool: string, args: Record<string, any>, ctx: ToolContext): Promise<unknown> {
    this.check(ctx);
    if (tool === 'qq_set_profile' && Object.keys(args).length === 0) throw new Error('请至少填写一项要修改的资料');
    if (tool === 'qq_self_info') {
      if (args.group_id) { await this.target(ctx, `group:${args.group_id}`); return this.api.call('get_group_member_info', { group_id: args.group_id, user_id: ctx.self, no_cache: true }, ctx.signal); }
      return this.api.call('get_login_info', {}, ctx.signal);
    }
    const readActions: Record<string, string> = { qq_get_friend_list: 'get_friend_list', qq_get_group_list: 'get_group_list', qq_get_group_member_list: 'get_group_member_list' };
    if (readActions[tool]) {
      if (args.group_id) await this.target(ctx, `group:${args.group_id}`);
      const result = await this.api.call<unknown>(readActions[tool], args, ctx.signal);
      if (Array.isArray(result)) return result.filter(item => !this.settings().social.blockedUsers.includes(String(item.user_id ?? '')) && !this.settings().social.blockedGroups.includes(String(item.group_id ?? '')));
      return result;
    }
    if (tool === 'qq_get_cookies') throw new Error('登录凭据不提供给会话模型；空间操作请使用专用适配服务');
    await this.approve(ctx, tool, true);
    const id = await this.store.beginAction(ctx.chat, tool);
    try {
      await this.quota(ctx, ctx.chat);
      let result: unknown;
      if (tool === 'qq_set_profile') {
        const { signature, ...profile } = args;
        result = {};
        if (Object.keys(profile).length) result = await this.api.call('set_qq_profile', profile, ctx.signal);
        if (signature !== undefined) result = await this.api.call('set_self_longnick', { longNick: signature }, ctx.signal);
      } else if (tool === 'qq_set_group_card') {
        await this.target(ctx, `group:${args.group_id}`);
        result = await this.api.call('set_group_card', { ...args, user_id: ctx.self }, ctx.signal);
      } else if (tool === 'qq_set_avatar') {
        const image = await this.media.image(args.file, ctx.signal);
        const file = await this.media.save(Buffer.from(image.data, 'base64'), '.' + image.mimeType.split('/')[1]);
        result = await this.api.call('set_qq_avatar', { file: toFile(file) }, ctx.signal);
      } else if (tool === 'qq_recall') {
        const message = this.message(ctx, args.message_id);
        if (!message.self || message.user !== ctx.self) throw new Error('只能撤回本账号在当前会话发送的消息');
        result = await this.api.call('delete_msg', { message_id: args.message_id }, ctx.signal);
        await this.store.update(d => { const m = d.messages.find(m => m.chat === ctx.chat && m.id === args.message_id); if (m) m.recalled = true; });
      } else throw new Error('未知 QQ 动作');
      await this.store.endAction(id, 'success', '已完成'); return result;
    } catch (error) { await this.store.endAction(id, 'unknown', String(error)); throw error; }
  }
  async tick(self: number, signal: AbortSignal, wake: (chat: string, reason: string) => Promise<void>): Promise<void> {
    if (this.tickRunning || !self || signal.aborted) return;
    this.tickRunning = true;
    try {
      const settings = this.settings();
      if (settings.social.remindersEnabled) {
        for (const task of this.store.dueTasks(Date.now())) {
          await this.fire(task, self, signal);
        }
      }
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
      const { quietStartHour: start, quietEndHour: end } = settings.social;
      const quiet = start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
      if (!settings.social.proactiveEnabled || quiet) return;
      const contacts = this.store.contacts().filter(c => c.at && allowedChat(settings.social, c.chat));
      for (const c of contacts) {
        if (this.store.profile(c.chat)?.proactive === false) continue;
        const interval = settings.social.proactiveIntervalMinutes * 60000;
        if (Date.now() - Math.max(c.at, this.proactiveAt.get(c.chat) ?? Date.now()) < interval) { if (!this.proactiveAt.has(c.chat)) this.proactiveAt.set(c.chat, Date.now()); continue; }
        this.proactiveAt.set(c.chat, Date.now());
        if (c.chat.startsWith('group:') && !settings.chat.group.proactive.enabled) continue;
        await wake(c.chat, '这是一个主动聊天机会，请结合近期记录判断是否值得开口；没话题就调用 qq_finish。发言需要主动额度。');
        break;
      }
    } finally { this.tickRunning = false; }
  }
  private async fire(task: ScheduledTask, self: number, signal: AbortSignal): Promise<void> {
    const ctx: ToolContext = { chat: task.chat, self, user: Number(task.creator), signal, sent: 0, silent: false };
    await this.store.update(d => { const t = d.tasks.find(t => t.id === task.id); if (!t || t.state !== 'pending') throw new Error('提醒状态已变化'); t.state = 'running'; });
    try {
      await this.approve(ctx, '定时提醒');
      await this.send(ctx, [{ type: 'text', data: { text: `提醒：${task.text}` } }], task.chat, true);
      await this.store.update(d => { const t = d.tasks.find(t => t.id === task.id)!; t.state = task.interval ? 'pending' : 'sent'; if (task.interval) t.due = Date.now() + task.interval; });
    } catch (e) {
      await this.store.update(d => { const t = d.tasks.find(t => t.id === task.id)!; t.state = 'unknown'; t.error = String(e).slice(0,1000); });
      this.log(`[reminder] ${task.id}: ${String(e)}`);
    }
  }
}

export function parseShanghaiTime(text: string): number {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) throw new Error('时间格式应为 YYYY-MM-DD HH:mm（上海时间）');
  const value = Date.parse(text.replace(' ', 'T') + ':00+08:00');
  if (!Number.isFinite(value) || new Date(value + 8 * 3600000).toISOString().slice(0,16).replace('T',' ') !== text) throw new Error('日期或时间无效');
  return value;
}
function toFile(file: string): string { return new URL('file:///' + file.replace(/\\/g, '/').replace(/^\//, '').split('/').map((p,i) => i === 0 && p.endsWith(':') ? p : encodeURIComponent(p)).join('/')).href; }
async function adapter(url: string, token: string | undefined, data: unknown, signal: AbortSignal): Promise<unknown> {
  const endpoint = new URL(url); if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('适配服务地址必须为 HTTP(S)');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok) throw new Error(`适配服务失败 (${response.status})`);
  return response.json();
}
