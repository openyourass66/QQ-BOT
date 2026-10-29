import {createSocialHandlers,type ToolHandler} from "./handlers/registry.js";
import {toFile} from "./handlers/shared.js";
export {parseShanghaiTime} from "./handlers/shared.js";
import { z } from 'zod';
import type {ScheduledTask} from './social-store.js';
import type {SocialRepository} from '../storage/social-repository.js';
import { MediaService } from '../services/media.js';
import { socialTools, SocialCallSchema, type ToolContext } from './social-tools.js';
import {assertAccountTool} from '../core/permissions.js';
import {assertToolAccess, assertTargetAccess, approvalBinding, approvalDescription} from '../security/tool-policy.js';
import { allowedChat } from './social-settings.js';
import type { BotSettings } from '../core/settings.js';
import {OneBotHttp, type Segment} from './onebot.js';
import type { DailyUsageStore, Quota } from '../core/usage.js';
import {StickerReviews, imageHash, stickerReviewPrompt} from './sticker-review.js';
import { QqStickers } from './qq-stickers.js';
import { Autonomy, quietTime } from '../agent/autonomy.js';
import type { AutonomousTurn } from '../agent/autonomous-state.js';
import {Cognition} from '../agent/cognition.js';
import { learningModel } from '../agent/learning-model.js';
import { turnBudget, toolAvailable, toolEnabled } from '../agent/context-policy.js';
import { QzoneService, type SpacePost } from '../services/qzone.js';
import type {PrepareServiceRequest} from '../agent/service-request.js';
import type {QqOperationService} from '../app/qq-operation-service.js';

export class SocialEngine {
  private readonly handlers:ReadonlyMap<string,ToolHandler>;
  private sending = new Map<string, Promise<unknown>>();
  private rates = new Map<string, number[]>();
  private contactsAt = 0;
  private friendIds = new Set<string>();
  private groupIds = new Set<string>();
  private groupFiles = new Map<string, Map<string, Record<string, unknown>>>();
  private tickRunning = false;
  private spaceContactsAt=0;
  private stickerReviews = new StickerReviews();
  readonly qqStickers: QqStickers;
  readonly autonomy:Autonomy;
  readonly cognition:Cognition;
  readonly qzone:QzoneService;
  constructor(readonly store: SocialRepository, readonly media: MediaService, private readonly api: OneBotHttp,
    private readonly usage: DailyUsageStore, private readonly settings: () => BotSettings,
    private readonly confirm: (title: string, signal: AbortSignal) => Promise<boolean>,
    private readonly onSent: (chat: string, id: number, segments: Segment[], source?: string) => void,
    private readonly log: (text: string) => void, qzone?:QzoneService,requests?:PrepareServiceRequest,private operations?:QqOperationService) {
      this.qqStickers=new QqStickers(store,media,api);this.autonomy=new Autonomy(store,settings,usage,undefined,media);
      const model=learningModel(process.env,requests);this.cognition=new Cognition(store,settings,usage,model.analyze,model.available,Date.now,model.prepare);
      this.qzone=qzone??new QzoneService(api,{blocked:user=>settings().social.blockedUsers.includes(String(user)),...(operations?{effect:<T>(payload:unknown,invoke:()=>Promise<T>)=>operations.effect('qzone_comment',payload,invoke)}:{})});
      this.handlers=createSocialHandlers(this.executionPort());
    }
  guardTool(ctx:ToolContext,name:string):void {
    ctx.budget??=turnBudget();
    if(ctx.budget.tools>=this.settings().context.toolsPerTurn)throw new Error('本轮 QQ 工具调用次数已达上限');
    if(this.settings().context.filterTools&&!toolAvailable(name,this.settings()))throw new Error('该工具已关闭或依赖尚未就绪');
    ctx.budget.tools++;
  }

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
    ctx.authorize?.();
    if(['qzone','qzone-comment'].includes(ctx.autonomous?.kind??'')&&target===ctx.chat&&ctx.chat===`private:${ctx.self}`)return;
    if (!allowedChat(this.settings().social, target, target === ctx.chat ? ctx.user : undefined)) throw new Error('该用户或会话已屏蔽或不在允许名单中');
  }
  async target(ctx: ToolContext, target: string, actor = false): Promise<void> {
    this.check(ctx, target);
    if(ctx.autonomous?.kind!=='qzone-comment')assertTargetAccess(ctx,this.settings(),target,actor);
    if(ctx.autonomous&&target!==ctx.chat)throw new Error('自主任务不能跨会话发送消息');
    if (target === ctx.chat) return;
    await this.contacts(ctx.signal);
    if (!(target.startsWith('group:') ? this.groupIds : this.friendIds).has(target.split(':')[1])) throw new Error('目标不是现有好友或已加入群，请先查询联系人');
  }
  private async spaceTarget(ctx:ToolContext,user:number):Promise<void> {
    this.autonomy.authorizeSpaceTarget(ctx,user);
    if(ctx.autonomous?.kind!=='qzone-comment'){await this.target(ctx,`private:${user}`);return;}
    this.check(ctx,`private:${user}`);await this.contacts(ctx.signal);
    if(!this.friendIds.has(String(user)))throw new Error('空间目标已不是当前 QQ 好友');
  }
  async approve(ctx: ToolContext, tool: string, sensitive = false, args: unknown = {}): Promise<void> {
    assertAccountTool(ctx, this.settings().approval.adminQq, tool);
    const mode = this.settings().social.autonomy;
    if (mode === 'confirm' || (mode === 'sensitive' && sensitive)) {
      const binding=approvalBinding(this.settings(),{tool,chat:ctx.chat,user:ctx.user,args});
      if(!await this.confirm(approvalDescription(ctx,tool,args),ctx.signal))throw new Error('操作未获确认');
      assertAccountTool(ctx, this.settings().approval.adminQq, tool);
      binding.assert(this.settings());
      const previous=ctx.authorize;ctx.authorize=()=>{previous?.();binding.assert(this.settings());};
    }
    this.check(ctx);
    assertAccountTool(ctx, this.settings().approval.adminQq, tool);
  }
  actionQuotas(ctx: ToolContext, key = ctx.chat): Quota[] {
    this.check(ctx);
    if(ctx.autonomous)this.autonomy.authorize(ctx,ctx.autonomous.kind==='qzone'?'qzone_post':ctx.autonomous.kind==='qzone-comment'?'qq_qzone_comment':ctx.autonomous.kind==='collect'?'qq_collect_sticker':'qq_reply');
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
    const quotas: Quota[] = [ctx.reminder ? { key: 'reminders', amount: 1, limit: s.budgets.remindersPerDay, label: '定时提醒' } : { key: 'proactive', amount: 1, limit: s.budgets.proactiveMessagesPerDay, label: '主动消息' }];
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
  async send(ctx: ToolContext, segments: Segment[], target = ctx.chat, proactive = false, onDispatch: () => void = () => {}): Promise<unknown> {
    if(this.operations)return this.operations.run(ctx,ctx.reminder?'reminder':'normal_reply',{target,segments,proactive},ctx.reminder?'发送提醒':'发送会话回复',()=>{this.check(ctx,target);this.autonomy.authorize(ctx,'qq_reply');},()=>this.sendRegistered(ctx,segments,target,proactive,onDispatch));
    return this.sendRegistered(ctx,segments,target,proactive,onDispatch);
  }
  private async sendRegistered(ctx:ToolContext,segments:Segment[],target:string,proactive:boolean,onDispatch:()=>void):Promise<unknown>{
    return this.serial(target, async () => {
      this.autonomy.authorize(ctx,'qq_reply');
      if (ctx.reminder) { const blocked = this.reminderBlockReason(ctx); if (blocked) throw new Error(blocked); }
      if(ctx.autonomous&&ctx.autonomous.messages>=2)throw new Error('本次主动聊天已达到两条消息，请留给对方回应');
      await this.target(ctx, target);
      await this.quota(ctx, target, () => this.proactiveQuotas(ctx, target, proactive));
      this.check(ctx, target);
      const [kind, id] = target.split(':');
      const plain = segments.length === 1 && segments[0].type === 'text';
      let result: { message_id: number };
      onDispatch();
      try { result = await this.api.call<{ message_id: number }>(kind === 'group' ? 'send_group_msg' : 'send_private_msg', { [kind === 'group' ? 'group_id' : 'user_id']: Number(id), message: plain ? segments[0].data.text : segments, ...(plain ? { auto_escape: true } : {}) }, ctx.signal); }
      catch (error) { ctx.silent = true;if(ctx.autonomous)ctx.autonomous.failure=String(error); throw error; }
      if (target === ctx.chat) ctx.sent++;
      try {await this.store.sent(target, ctx.self, result.message_id, segments, this.settings().identity.name);await this.autonomy.sent(ctx);}
      catch(error){if(ctx.autonomous)ctx.autonomous.failure='消息已提交协议端但记录保存失败：'+String(error);throw error;}
      this.onSent(target, result.message_id, segments, ctx.chat);
      return { ...result, sent: true, target };
    });
  }
  async normalReply(ctx: ToolContext, text: string): Promise<unknown> {
    return this.send(ctx, [{ type: 'text', data: { text } }]);
  }
  private async decorators(ctx: ToolContext, args: Record<string, unknown>): Promise<Segment[]> {
    const parts: Segment[] = [];
    if (args.reply_to !== undefined) { await this.message(ctx, Number(args.reply_to)); parts.push({ type: 'reply', data: { id: String(args.reply_to) } }); }
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
    this.guardTool(ctx,call.tool);
    this.autonomy.authorize(ctx,call.tool);
    assertAccountTool(ctx, this.settings().approval.adminQq, call.tool);
    const {tool,args,mutates}=this.describe(input);
    assertToolAccess(ctx,this.settings(),call.tool,args);
    const actionId = mutates ? await this.store.beginAction(ctx.chat, call.tool) : undefined;
    const previousAuthorization=ctx.authorize;
    ctx.authorize=()=>{previousAuthorization?.();assertToolAccess(ctx,this.settings(),call.tool,args);if(!toolEnabled(call.tool,this.settings()))throw new Error('该工具已关闭或依赖尚未就绪');};
    try {
      if (mutates&&call.tool!=='qq_qzone_comment') await this.approve(ctx, call.tool, call.tool==='qq_handle_request',args);
      const result = await this.perform(call.tool, args, ctx);
      if (actionId) await this.store.endAction(actionId, 'success', `${tool.title}：${String(args.text ?? args.name ?? args.note ?? '已完成')}`);
      return result;
    } catch (e) {
      if (actionId) await this.store.endAction(actionId, 'unknown', String(e));
      throw e;
    } finally {ctx.authorize=previousAuthorization;}
  }
  describe(input:unknown){
    const call=SocialCallSchema.parse(input),tool=socialTools.find(tool=>tool.name===call.tool);if(!tool)throw new Error('未知 QQ 工具');
    const args=z.object(tool.schema as z.ZodRawShape).strict().parse(call.args) as Record<string,any>;
    const reads = new Set(['qq_capabilities', 'qq_recent_messages', 'qq_message', 'qq_read_forward', 'qq_active_members', 'qq_chats', 'qq_images', 'qq_stickers', 'qq_sticker_image', 'qq_memory_query', 'qq_reminders', 'qq_events', 'qq_transcribe', 'qq_video', 'qq_file', 'qq_event_file', 'qq_group_files', 'qq_qzone_feed', 'qq_finish', 'qq_report']);
    reads.add('qq_self_state');
    const collectPreview = call.tool === 'qq_collect_sticker' && !args.analysis_token;
    const sendSticker = call.tool === 'qq_send_sticker' ? this.store.view('stickers').stickers.find(s => s.id === args.sticker_id) : undefined;
    if (sendSticker?.analysis?.confidence === 'low') throw new Error('这张表情含义尚不确定，请结合上下文重新看图分析，或选择其他已理解的表情');
    const sendPreview = call.tool === 'qq_send_sticker' && !sendSticker?.analysis;
    const mutates = !reads.has(call.tool) && !['qq_group_file','qq_actions'].includes(call.tool) && !(call.tool === 'qq_send_image' && args.preview) && !collectPreview && !sendPreview;
    return {call,tool,args,mutates};
  }
  private executionPort(){const engine=this;return {
      send:this.send.bind(this),
      decorators:this.decorators.bind(this),
      get api(){return engine.api;},
      settings:this.settings.bind(this),
      get store(){return engine.store;},
      message:this.message.bind(this),
      contacts:this.contacts.bind(this),
      quota:this.quota.bind(this),
      feature:this.feature.bind(this),
      messageImage:this.messageImage.bind(this),
      get media(){return engine.media;},
      messageSource:this.messageSource.bind(this),
      get autonomy(){return engine.autonomy;},
      get qqStickers(){return engine.qqStickers;},
      prepareStickerReview:this.prepareStickerReview.bind(this),
      serial:<T>(key:string,operation:()=>Promise<T>)=>this.serial(key,operation),
      checkedStickerReview:this.checkedStickerReview.bind(this),
      get stickerReviews(){return engine.stickerReviews;},
      check:this.check.bind(this),
      reminderBlockReason:this.reminderBlockReason.bind(this),
      get operations(){return engine.operations;},
      source:this.source.bind(this),
      get groupFiles(){return engine.groupFiles;},
      proactiveQuotas:this.proactiveQuotas.bind(this),
      onSent:this.onSent.bind(this),
      spaceTarget:this.spaceTarget.bind(this),
      get qzone(){return engine.qzone;},
      confirm:this.confirm.bind(this),
      log:this.log.bind(this)
    };}
  private async perform(tool:string,a:Record<string,any>,ctx:ToolContext):Promise<unknown>{
    if(["qq_stickers","qq_sticker_note"].includes(tool))await this.qqStickers.sync(ctx.signal);
    const handler=this.handlers.get(tool);if(!handler)throw new Error("未知 QQ 工具");return handler(tool,a,ctx);
  }
  private async messageSource(ctx: ToolContext, id: number, type: string): Promise<string> {
    const s = (await this.message(ctx, id)).segments.find(s => s.type === type); if (!s) throw new Error('该消息没有所需媒体');
    return this.source(s, ctx);
  }
  private async message(ctx: ToolContext, id: number) {
    const message = await this.store.message(ctx.chat, id);
    if (this.settings().social.blockedUsers.includes(String(message.user))) throw new Error('该消息的发送者已屏蔽，不能读取或引用');
    return message;
  }
  private async prepareStickerReview(ctx: ToolContext, target: { messageId?: number; stickerId?: string }, image: { type: 'image'; data: string; mimeType: string }, oldNote?: string, intent: 'collect' | 'send' | 'view' = 'view') {
    const buffer = Buffer.from(image.data, 'base64'), hash = imageHash(buffer);
    const existing = target.stickerId ? this.store.view('stickers').stickers.find(s => s.id === target.stickerId) : undefined;
    const file = existing?.file ?? await this.media.save(buffer, '.' + image.mimeType.split('/')[1]);
    const visual = await this.media.vision([image], stickerReviewPrompt, ctx.signal) as { content?: any[]; text?: string };
    if (!visual || (!visual.content?.some(c => c.type === 'image' && c.data) && !(typeof visual.text === 'string' && visual.text.trim()))) throw new Error('未取得可用的原图或视觉分析，尚未完成收藏');
    this.check(ctx); this.feature('stickersEnabled');
    if (target.messageId !== undefined) await this.message(ctx, target.messageId);
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
    if (target.messageId !== undefined) await this.message(ctx, target.messageId);
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
    this.autonomy.authorize(ctx,tool);
    this.check(ctx);
    if (tool === 'qq_set_profile' && Object.keys(args).length === 0) throw new Error('请至少填写一项要修改的资料');
    assertAccountTool(ctx, this.settings().approval.adminQq, tool);
    assertToolAccess(ctx,this.settings(),tool,args);
    if (tool === 'qq_self_info') {
      if (args.group_id) { await this.target(ctx, `group:${args.group_id}`); return this.api.call('get_group_member_info', { group_id: args.group_id, user_id: ctx.self, no_cache: true }, ctx.signal); }
      return this.api.call('get_login_info', {}, ctx.signal);
    }
    const readActions: Record<string, string> = { qq_get_friend_list: 'get_friend_list', qq_get_group_list: 'get_group_list', qq_get_group_member_list: 'get_group_member_list' };
    if (readActions[tool]) {
      if (args.group_id) await this.target(ctx, `group:${args.group_id}`);
      const result = await this.api.call<unknown>(readActions[tool], args, ctx.signal);
      this.check(ctx);assertToolAccess(ctx,this.settings(),tool,args);
      if (Array.isArray(result)) return result.filter(item => !this.settings().social.blockedUsers.includes(String(item.user_id ?? '')) && !this.settings().social.blockedGroups.includes(String(item.group_id ?? '')) && (tool==='qq_get_group_member_list'||allowedChat(this.settings().social,`${tool==='qq_get_group_list'?'group':'private'}:${item.group_id??item.user_id}`)));
      return result;
    }
    if (tool === 'qq_get_cookies') throw new Error('登录凭据不提供给会话模型；空间操作请使用空间浏览与评论工具');
    const previousAuthorization=ctx.authorize;
    ctx.authorize=()=>{previousAuthorization?.();assertToolAccess(ctx,this.settings(),tool,args);};
    let id:string|undefined;
    try {
      await this.approve(ctx, tool, true,args);
      id = await this.store.beginAction(ctx.chat, tool);
      await this.quota(ctx, ctx.chat);
      let result: unknown;
      if (tool === 'qq_set_profile') {
        const { signature, ...profile } = args;
        result = {};
        if (Object.keys(profile).length) { assertAccountTool(ctx, this.settings().approval.adminQq, tool); result = await this.api.call('set_qq_profile', profile, ctx.signal); }
        if (signature !== undefined) { assertAccountTool(ctx, this.settings().approval.adminQq, tool); result = await this.api.call('set_self_longnick', { longNick: signature }, ctx.signal); }
      } else if (tool === 'qq_set_group_card') {
        await this.target(ctx, `group:${args.group_id}`);
        assertAccountTool(ctx, this.settings().approval.adminQq, tool);
        result = await this.api.call('set_group_card', { ...args, user_id: ctx.self }, ctx.signal);
      } else if (tool === 'qq_set_avatar') {
        const image = await this.media.image(args.file, ctx.signal);
        const file = await this.media.save(Buffer.from(image.data, 'base64'), '.' + image.mimeType.split('/')[1]);
        assertAccountTool(ctx, this.settings().approval.adminQq, tool);
        result = await this.api.call('set_qq_avatar', { file: toFile(file) }, ctx.signal);
      } else if (tool === 'qq_recall') {
        const message = await this.message(ctx, args.message_id);
        if (!message.self || message.user !== ctx.self) throw new Error('只能撤回本账号在当前会话发送的消息');
        result = await this.api.call('delete_msg', { message_id: args.message_id }, ctx.signal);
        await this.store.updateWithMessages(ctx.chat,[args.message_id],d => { const m = d.messages.find(m => m.chat === ctx.chat && m.id === args.message_id); if (m) m.recalled = true; });
      } else throw new Error('未知 QQ 动作');
      await this.store.endAction(id, 'success', '已完成'); return result;
    } catch (error) { if(id)await this.store.endAction(id, 'unknown', String(error)); throw error; }
    finally {ctx.authorize=previousAuthorization;}
  }
  async tick(self: number, signal: AbortSignal, wake: (chat: string, reason: string,autonomous?:AutonomousTurn) => Promise<void|boolean>,canWake?:(chat:string,kind:AutonomousTurn['kind'])=>boolean,reserveOnWake=false): Promise<void> {
    if (this.tickRunning || !self || signal.aborted) return;
    this.tickRunning = true;
    try {
      const settings = this.settings();
      if (settings.social.remindersEnabled) {
        for (const task of await this.store.dueTasks(Date.now())) {
          await this.fire(task, self, signal);
        }
      }
      if(settings.social.proactiveEnabled&&settings.social.autonomousEnabled&&!quietTime(settings)&&settings.social.autoQzoneCommentEnabled&&settings.features.qzone.browseEnabled&&settings.features.qzone.commentsEnabled&&Date.now()-this.spaceContactsAt>=60000){this.spaceContactsAt=Date.now();try{await this.contacts(signal);}catch{this.log('[autonomy] 无法刷新好友，自主空间互动等待 QQ 连接恢复');}}
      await this.autonomy.tick(signal,(t,a)=>wake(t.chat,`自主想法 #${t.id}（${t.kind}）：${t.summary}\n依据：${t.reason}\n${t.messageId!==undefined?'来源消息 #'+t.messageId:''}\n判断现在是否值得行动。没内容就 qq_finish；想以后再做用 qq_thought 推迟。只以实际工具结果算完成。`,a),t=>canWake?.(t.chat,t.kind)??true,async(t,a)=>{
        if(t.kind!=='qzone-comment')return true;
        const ctx:ToolContext={chat:`private:${self}`,self,user:self,signal,sent:0,silent:false,proactive:true,autonomous:a};
        await this.spaceTarget(ctx,t.targetUser!);
        const result=await this.qzone.feed(ctx.chat,self,t.targetUser!,3,0,signal) as {posts:SpacePost[]};
        this.autonomy.authorizeSpaceTarget(ctx,t.targetUser!);
        const post=result.posts.find(p=>p.created_at>Date.now()-24*3600000&&!p.comments.some(comment=>comment.user_id===self)&&!this.autonomy.spaceCommentSeen(p.url));
        if(!post){a.reason='好友近期没有新的可评论动态，或动态已评论、结果待核对；本轮不唤醒模型';return false;}
        a.spacePost=post;return true;
      },reserveOnWake);
    } finally { this.tickRunning = false; }
  }
  private reminderBlockReason(ctx: ToolContext, creating = false): string {
    const s = this.settings();
    if (!s.social.remindersEnabled) return '定时提醒已关闭';
    if (!allowedChat(s.social, ctx.chat, ctx.user)) return '会话已屏蔽或不在允许名单中';
    if (ctx.chat.startsWith('group:') && !s.chat.group.proactive.enabled) return '请先开启群聊主动发言';
    const quotas = [{ key: 'social-actions', limit: s.social.actionsPerDay, label: 'QQ 动作' }, ...this.proactiveQuotas({ ...ctx, reminder: true }, ctx.chat, true)];
    for (const q of quotas) if (q.limit === 0 || (!creating && this.usage.used(q.key) >= q.limit)) return `${q.label}额度不足，请检查额度与节奏`;
    if (s.social.autonomy === 'confirm' && !s.approval.adminQq) return '所有动作需确认，请先配置管理员 QQ';
    return '';
  }
  private async fire(task: ScheduledTask, self: number, signal: AbortSignal): Promise<void> {
    const ctx: ToolContext = { chat: task.chat, self, user: Number(task.creator), signal, sent: 0, silent: false, reminder: true };
    const blocked = this.reminderBlockReason(ctx);
    if (blocked) {
      await this.store.update(d => { const t = d.tasks.find(t => t.id === task.id); if (t && ['pending','blocked'].includes(t.state)) { t.state = 'blocked'; t.error = `尚未发送：${blocked}；条件恢复后自动重试，也可取消`; t.retryAt = Date.now() + 60000; } });
      return;
    }
    const claimed=await this.store.claimTask(task.id,Date.now());if(!claimed)return;task=claimed;const claimId=task.claim!.id,now=Date.now();
    ctx.operationKey='reminder:'+claimId;
    if(task.interval&&now-task.due>task.interval){await this.store.finishTask(task.id,claimId,{state:'pending',error:'停机或睡眠期间已错过提醒，已跳过积压时段并安排下次。',retryAt:0,due:now+task.interval});return;}
    if(!task.interval&&now-task.due>86400000){await this.store.finishTask(task.id,claimId,{state:'failed',error:'一次性提醒已迟到超过二十四小时，未补发；请核对后重新安排。',retryAt:0});return;}
    let dispatched = false;
    try {
      await this.approve(ctx, '定时提醒');
      await this.send(ctx, [{ type: 'text', data: { text: `提醒：${task.text}` } }], task.chat, true, () => { dispatched = true; });
      await this.store.finishTask(task.id,claimId,{state:task.interval?'pending':'sent',error:'',retryAt:0,...(task.interval?{due:Date.now()+task.interval}:{})});
    } catch (e) {
      const state=dispatched?'unknown':String(e).includes('未获确认')?'failed':'blocked';
      await this.store.finishTask(task.id,claimId,{state,error:`${dispatched?'已提交发送，结果待核对，不自动重发':state==='failed'?'未获管理员确认，提醒已停止':'尚未发送，稍后自动重试'}：${String(e)}`.slice(0,1000),retryAt:Date.now()+60000});
      this.log(`[reminder] ${task.id}: ${String(e)}`);
    }
  }
}


export type SocialExecutionPort=ReturnType<SocialEngine["executionPort"]>;
