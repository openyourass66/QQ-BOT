import { createHash, randomUUID } from 'node:crypto';
import type { SocialStore, SocialData } from '../qq/social-store.js';
import type { BotSettings } from '../core/settings.js';
import type { ToolContext } from '../qq/social-tools.js';
import type { Thought, AutonomousTurn } from './autonomous-state.js';
import type { DailyUsageStore, Quota } from '../core/usage.js';
import { shanghaiDate } from '../core/usage.js';
import { allowedChat } from '../qq/social-settings.js';
import { MediaService, downloadPublic, imageMime } from '../services/media.js';
import { pathToFileURL } from 'node:url';

const minute=60000,hour=60*minute;
const common=['qq_self_state','qq_interest','qq_thought','qq_finish','qq_report'];
const imageTools=['qq_images','qq_message','qq_recent_messages','qq_stickers','qq_sticker_image','qq_sticker_note','qq_collect_sticker'];
const chatTools=['qq_reply','qq_send_image','qq_send_sticker','qq_read_forward','qq_memory_query','qq_memory_append','qq_memory_remove'];
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export function quietTime(s:BotSettings,now=Date.now()):boolean {
  const current=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hourCycle:'h23'}).format(new Date(now)));
  const start=s.social.quietStartHour,end=s.social.quietEndHour;
  return start!==end && (start<end ? current>=start&&current<end : current>=start||current<end);
}
function prune(d:SocialData,now:number):void {
  for(const t of d.autonomous.thoughts)if(t.state==='pending'&&t.expires<=now){t.state='expired';t.result='想法已过期';}
  d.autonomous.thoughts=d.autonomous.thoughts.filter(t=>['pending','running'].includes(t.state)).slice(-200)
    .concat(d.autonomous.thoughts.filter(t=>!['pending','running'].includes(t.state)).slice(-800));
}

/** Candidate selection is local; the existing conversation model decides whether to act. */
export class Autonomy {
  private running=false;
  private nextScanAt=0;
  private scanInterval=0;
  constructor(private store:SocialStore,private settings:()=>BotSettings,private usage:DailyUsageStore,private now=()=>Date.now(),private media?:MediaService){}
  private enabled():boolean {const s=this.settings();return s.social.autonomousEnabled&&s.social.proactiveEnabled&&!quietTime(s,this.now());}
  view(ctx:ToolContext):unknown {
    const d=this.store.snapshot().autonomous,scope=ctx.autonomous?.kind==='qzone'?'':ctx.chat;
    return {enabled:this.settings().social.autonomousEnabled,publicInterests:this.settings().social.personalInterests,
      interests:d.interests.filter(i=>i.chat===scope).slice(-30),
      thoughts:d.thoughts.filter(t=>t.chat===scope&&['pending','running'].includes(t.state)).slice(-20),
      decisions:d.decisions.filter(t=>t.chat===scope).slice(-8),...(scope===''?{recentPublicPosts:d.posts.slice(-8).map(p=>({at:p.at,state:p.state,summary:p.summary}))}:{})};
  }
  prompt(ctx:ToolContext):string {
    if(!this.settings().social.autonomousEnabled)return '';
    return '【自己的兴趣与打算（背景材料）】\n'+JSON.stringify(this.view(ctx))+'\n只记录有依据且以后值得继续的想法。用 qq_interest 逐渐调整兴趣，用 qq_thought 记住未完话题、推迟或放弃想法；不用每轮记笔记。兴趣和经历保持来源会话隔离。';
  }
  authorize(ctx:ToolContext,tool:string):void {
    const a=ctx.autonomous;if(!a||tool==='qq_finish')return;
    if(a.failure&&!['qq_self_state','qq_report'].includes(tool))throw new Error('上一个自主动作结果待核对，本轮停止追加操作');
    if(!this.enabled())throw new Error('自主任务已关闭或已进入安静时段');
    const thought=this.store.snapshot().autonomous.thoughts.find(t=>t.id===a.thoughtId);
    if(!thought||thought.state!=='running'||thought.expires<=this.now())throw new Error('这条自主想法已取消、过期或停止执行');
    const s=this.settings();
    if(a.kind!=='qzone'&&(!allowedChat(s.social,ctx.chat,ctx.user)||this.store.profile(ctx.chat)?.proactive===false))throw new Error('该会话不允许自主活动');
    if(a.kind==='collect'&&(!s.social.autoCollectStickers||!s.social.stickersEnabled))throw new Error('后台收藏已关闭');
    if(tool==='qq_collect_sticker'&&!s.social.autoCollectStickers)throw new Error('后台收藏已关闭');
    if(a.kind==='qzone'&&(!s.social.autoQzoneEnabled||!s.features.qzone.enabled))throw new Error('自主空间发布已关闭');
    const allowed=a.kind==='qzone'?[...common,'qzone_post']:
      a.kind==='collect'?[...common,...imageTools]:[...common,...imageTools,...chatTools];
    if(!allowed.includes(tool))throw new Error('当前自主任务不允许执行这个操作');
  }
  private evidence(ctx:ToolContext,id:number|undefined,image=false) {
    if(id===undefined)throw new Error('请用实际收到的消息编号作为依据');
    const m=this.store.message(ctx.chat,id);
    if(m.self||m.recalled||this.settings().social.blockedUsers.includes(String(m.user)))throw new Error('不能用自己、已撤回或已屏蔽的消息作为依据');
    if(image&&!m.segments.some(s=>s.type==='image'))throw new Error('收藏想法需要实际图片消息');
    return m;
  }
  async interest(ctx:ToolContext,a:{topic:string;reason:string;strength:number;message_id?:number}):Promise<unknown> {
    if(!this.settings().social.autonomousEnabled)throw new Error('兴趣与想法已关闭');
    const publicTask=ctx.autonomous?.kind==='qzone',scope=publicTask?'':ctx.chat;
    if(!publicTask)this.evidence(ctx,a.message_id);
    return this.store.update(d=>{
      const old=d.autonomous.interests.find(i=>i.chat===scope&&i.topic.toLocaleLowerCase()===a.topic.toLocaleLowerCase());
      if(old){
        const fresh=publicTask?this.now()-old.updatedAt>=hour:a.message_id!==old.messageId;
        if(fresh)old.strength=Math.max(old.strength-1,Math.min(old.strength+1,a.strength));
        old.reason=a.reason;old.updatedAt=this.now();if(a.message_id!==undefined)old.messageId=a.message_id;return old;
      }
      if(d.autonomous.interests.length>=1000)throw new Error('兴趣记录已满，请在工作台整理');
      const item={id:randomUUID(),chat:scope,topic:a.topic,reason:a.reason,strength:Math.min(3,a.strength),at:this.now(),updatedAt:this.now(),source:publicTask?'public' as const:'conversation' as const,...(!publicTask?{messageId:a.message_id}:{})};
      d.autonomous.interests.push(item);return item;
    });
  }
  async thought(ctx:ToolContext,a:{op:string;thought_id?:string;kind:Thought['kind'];summary?:string;reason:string;message_id?:number;delay_minutes:number;expires_hours:number;priority:number}):Promise<unknown> {
    if(!this.settings().social.autonomousEnabled)throw new Error('兴趣与想法已关闭');
    const scope=ctx.autonomous?.kind==='qzone'?'':ctx.chat;
    if(a.op==='remember') {
      if(!a.summary)throw new Error('请填写想法内容');
      if((a.kind==='qzone')!==(scope===''))throw new Error('空间创作与聊天想法使用独立上下文');
      if(!scope&&a.message_id!==undefined)throw new Error('独立空间想法不能引用聊天消息');
      if(scope)this.evidence(ctx,a.message_id,a.kind==='collect');
      if(a.delay_minutes*minute>=a.expires_hours*hour)throw new Error('执行时间必须早于过期时间');
    }
    return this.store.update(d=>{
      prune(d,this.now());
      if(a.op!=='remember') {
        const t=d.autonomous.thoughts.find(t=>t.id===a.thought_id&&t.chat===scope);
        if(!t||!['pending','running'].includes(t.state))throw new Error('这条想法不存在或已经结束');
        if(a.op==='dismiss'){t.state='dismissed';t.result=a.reason;}
        else {const due=this.now()+a.delay_minutes*minute;if(due>=t.expires)throw new Error('推迟时间超过想法有效期');t.state='pending';t.due=due;t.result=a.reason;}
        return t;
      }
      const key=digest(`${scope}|${a.kind}|${a.message_id??''}|${a.summary!.trim().toLocaleLowerCase()}`);
      const old=d.autonomous.thoughts.find(t=>t.key===key);if(old)return old;
      if(d.autonomous.thoughts.filter(t=>['pending','running'].includes(t.state)).length>=200)throw new Error('待处理想法已达上限，请先整理');
      const t:Thought={id:randomUUID(),key,chat:scope,kind:a.kind,summary:a.summary!,reason:a.reason,...(a.message_id!==undefined?{messageId:a.message_id}:{}),at:this.now(),due:this.now()+a.delay_minutes*minute,expires:this.now()+a.expires_hours*hour,priority:a.priority,state:'pending',result:''};
      d.autonomous.thoughts.push(t);return t;
    });
  }
  async observe(chat:string,id:number):Promise<void> {
    if(!this.settings().social.autonomousEnabled)return;
    const m=this.store.snapshot().messages.find(m=>m.chat===chat&&m.id===id);if(!m||m.self||m.recalled)return;
    await this.store.update(d=>{
      let c=d.autonomous.contacts.find(c=>c.chat===chat);
      if(!c){c={chat,incomingAt:m.at,proactiveAt:0,unanswered:0,attemptAt:0};d.autonomous.contacts.push(c);d.autonomous.contacts=d.autonomous.contacts.slice(-5000);}
      c.incomingAt=Math.max(c.incomingAt,m.at);c.unanswered=0;
      prune(d,this.now());
      if(!this.settings().social.autoCollectStickers||!m.segments.some(s=>s.type==='image'))return;
      const key=`image:${chat}:${id}`;
      if(d.autonomous.thoughts.some(t=>t.key===key)||d.autonomous.thoughts.filter(t=>t.state==='pending').length>=200)return;
      d.autonomous.thoughts.push({id:randomUUID(),key,chat,kind:'collect',summary:'看看新图片是否有收藏价值',reason:'实际收到新图片，结合兴趣、画面含义和是否重复判断；可以不收藏',messageId:id,at:this.now(),due:this.now()+2*minute,expires:this.now()+24*hour,priority:40,state:'pending',result:''});
    });
  }
  async sent(ctx:ToolContext):Promise<void> {
    if(!ctx.autonomous)return;
    ctx.autonomous.effects.add('chat');ctx.autonomous.messages++;
    await this.store.update(d=>{
      let c=d.autonomous.contacts.find(c=>c.chat===ctx.chat);
      if(!c){c={chat:ctx.chat,incomingAt:0,proactiveAt:0,unanswered:0,attemptAt:this.now()};d.autonomous.contacts.push(c);}
      c.proactiveAt=this.now();c.unanswered=1;
    });
  }
  collectionQuotas(ctx:ToolContext):Quota[] {
    if(!ctx.autonomous)return [];
    this.authorize(ctx,'qq_collect_sticker');
    return [{key:'autonomous-collections',amount:1,limit:this.settings().social.autoCollectPerDay,label:'后台表情收藏'}];
  }
  async collected(ctx:ToolContext,messageId:number):Promise<void> {
    ctx.autonomous?.effects.add('collect');
    await this.store.update(d=>{for(const t of d.autonomous.thoughts)if(t.chat===ctx.chat&&t.kind==='collect'&&t.messageId===messageId&&t.state==='pending'){t.state='done';t.result='已在对话中完成 QQ 收藏';}});
  }
  stickerRecency(chat:string):Map<string,number> {
    const used=new Map<string,number>();for(const s of this.store.snapshot().autonomous.stickerUses)if(s.chat===chat)used.set(s.stickerId,Math.max(s.at,used.get(s.stickerId)??0));return used;
  }
  lastSticker(chat:string,id:string):number {return this.stickerRecency(chat).get(id)??0;}
  async usedSticker(chat:string,id:string):Promise<void> {await this.store.update(d=>{d.autonomous.stickerUses.push({chat,stickerId:id,at:this.now()});d.autonomous.stickerUses=d.autonomous.stickerUses.slice(-1000);});}
  async publish(ctx:ToolContext,text:string,images:string[],run:(extra:Quota[],images:string[])=>Promise<unknown>):Promise<unknown> {
    this.authorize(ctx,'qzone_post');
    if(!ctx.autonomous)return run([],images);
    if(ctx.autonomous.effects.has('qzone'))throw new Error('本次自主机会已经发布过空间');
    const publicImages:string[]=[];
    for(const source of images) {
      if(!/^https?:\/\//i.test(source))throw new Error('自主空间配图只接受可核验的公网图片地址，不能读取本地或聊天缓存');
      if(!this.media)throw new Error('自主配图缓存不可用');
      const {buffer}=await downloadPublic(source,ctx.signal,12_000_000),mime=imageMime(buffer);
      publicImages.push(pathToFileURL(await this.media.save(buffer,'.'+mime.split('/')[1])).href);
    }
    const hash=digest(text.trim().replace(/\s+/g,' ')+'|'+images.join('|'));
    await this.store.update(d=>{
      if(d.autonomous.posts.some(p=>p.hash===hash&&this.now()-p.at<30*24*hour))throw new Error('这条空间内容已发布或结果待核对，请勿重复发布');
      d.autonomous.posts.push({hash,at:this.now(),state:'running',tid:'',summary:text.slice(0,200)});d.autonomous.posts=d.autonomous.posts.slice(-100);
    });
    try {
      const result=await run([{key:'autonomous-qzone',amount:1,limit:this.settings().social.autoQzonePerDay,label:'自主空间发布'}],publicImages);
      const tid=(result as {tid?:unknown})?.tid;
      if(typeof tid!=='string'||!tid.trim())throw new Error('空间发布没有返回有效 tid，结果待核对，不自动重发');
      ctx.autonomous.effects.add('qzone');
      await this.store.update(d=>{const p=d.autonomous.posts.find(p=>p.hash===hash);if(p){p.state='success';p.tid=tid;}});
      return result;
    } catch(error) {ctx.autonomous.failure=String(error);await this.store.update(d=>{const p=d.autonomous.posts.find(p=>p.hash===hash);if(p)p.state='unknown';});throw error;}
  }
  async tick(signal:AbortSignal,wake:(t:Thought,a:AutonomousTurn)=>Promise<void|boolean>):Promise<void> {
    if(this.running||signal.aborted||!this.enabled())return;
    const s=this.settings(),now=this.now(),interval=s.social.proactiveIntervalMinutes*minute;
    if(this.scanInterval!==interval){this.scanInterval=interval;this.nextScanAt=0;}
    if(now<this.nextScanAt)return;
    const before=this.store.snapshot();
    if(now-before.autonomous.lastScanAt<interval){this.nextScanAt=before.autonomous.lastScanAt+interval;return;}
    this.nextScanAt=now+interval;
    this.running=true;
    try {
      await this.store.update(d=>{
        d.autonomous.lastScanAt=now;prune(d,now);
        const incomingByChat=new Map<string,SocialData['messages'][number]>(),keys=new Set(d.autonomous.thoughts.map(t=>t.key));
        let pending=d.autonomous.thoughts.filter(t=>['pending','running'].includes(t.state)).length;
        for(let index=d.messages.length-1;index>=0;index--){const m=d.messages[index];if(!incomingByChat.has(m.chat)&&!m.self&&!m.recalled&&!s.social.blockedUsers.includes(String(m.user)))incomingByChat.set(m.chat,m);}
        for(const contact of d.contacts.filter(c=>c.at&&allowedChat(s.social,c.chat)).sort((a,b)=>b.at-a.at)) {
          const incoming=incomingByChat.get(contact.chat);
          if(!incoming||incoming.at+72*hour<=now)continue;
          const previous=d.autonomous.contacts.find(c=>c.chat===contact.chat);
          if(previous&&incoming.at>previous.incomingAt){previous.incomingAt=incoming.at;previous.unanswered=0;}
          const key=`chat:${contact.chat}:${incoming.id}`;
          if(keys.has(key)||pending>=200)continue;
          d.autonomous.thoughts.push({id:randomUUID(),key,chat:contact.chat,kind:'chat',summary:'看看最近的话题是否值得继续',reason:'以实际聊天和兴趣判断，有具体想说的话才开口；可以保持安静',messageId:incoming.id,at:now,due:Math.max(now,incoming.at+interval),expires:incoming.at+72*hour,priority:35,state:'pending',result:''});
          keys.add(key);pending++;
        }
        if(s.social.autoQzoneEnabled&&s.features.qzone.enabled&&s.social.autoQzonePerDay>0&&now-d.autonomous.lastQzoneAttempt>=s.social.qzoneIntervalHours*hour&&d.autonomous.thoughts.filter(t=>t.state==='pending').length<200&&!d.autonomous.thoughts.some(t=>t.kind==='qzone'&&['pending','running'].includes(t.state))) {
          const day=shanghaiDate(new Date(now)),key='qzone:'+day+':'+Math.floor(now/(s.social.qzoneIntervalHours*hour));
          if(!d.autonomous.thoughts.some(t=>t.key===key))d.autonomous.thoughts.push({id:randomUUID(),key,chat:'',kind:'qzone',summary:'想想有没有值得分享的公开内容',reason:'结合全局创作兴趣和公开素材形成自己的表达；没有内容可不发布',at:now,due:now,expires:now+6*hour,priority:30,state:'pending',result:''});
        }
        prune(d,now);
      });
      if(this.usage.used('autonomous-decisions')>=s.social.autonomousDecisionsPerDay)return;
      if(this.usage.used('social-actions')>=s.social.actionsPerDay)return;
      const d=this.store.snapshot(),eligible=d.autonomous.thoughts.filter(t=>{
        if(t.state!=='pending'||t.due>now||t.expires<=now)return false;
        if(t.kind==='qzone')return s.social.autoQzoneEnabled&&s.features.qzone.enabled&&now-d.autonomous.lastQzoneAttempt>=s.social.qzoneIntervalHours*hour&&this.usage.used('autonomous-qzone')<s.social.autoQzonePerDay&&this.usage.used('qzone')<s.features.qzone.dailyLimit;
        if(!allowedChat(s.social,t.chat)||this.store.profile(t.chat)?.proactive===false)return false;
        if(t.messageId!==undefined){const m=d.messages.find(m=>m.chat===t.chat&&m.id===t.messageId);if(!m||m.recalled||m.self||s.social.blockedUsers.includes(String(m.user)))return false;}
        const c=d.autonomous.contacts.find(c=>c.chat===t.chat);
        if(t.kind==='collect')return s.social.autoCollectStickers&&s.social.stickersEnabled&&this.usage.used('autonomous-collections')<s.social.autoCollectPerDay;
        if(t.chat.startsWith('group:')&&!s.chat.group.proactive.enabled)return false;
        if(t.chat.startsWith('group:')&&this.usage.used('group:'+t.chat.split(':')[1])>=s.chat.group.proactive.perGroupPerDay)return false;
        if(this.usage.used('proactive')>=s.budgets.proactiveMessagesPerDay)return false;
        return !c?.unanswered&&now-Math.max(c?.proactiveAt??0,c?.attemptAt??0)>=s.social.autonomousChatCooldownMinutes*minute&&now-Math.max(c?.incomingAt??0,d.contacts.find(x=>x.chat===t.chat)?.at??0)>=interval;
      });
      const rank=(t:Thought)=>t.priority+Math.min(40,(now-t.at)/hour*2);
      const t=eligible.sort((a,b)=>rank(b)-rank(a)||a.at-b.at)[0];if(!t)return;
      await this.usage.consume(()=>[{key:'autonomous-decisions',amount:1,limit:this.settings().social.autonomousDecisionsPerDay,label:'自主判断'}]);
      await this.store.update(data=>{
        const current=data.autonomous.thoughts.find(x=>x.id===t.id);if(!current||current.state!=='pending')throw new Error('想法状态已变化');current.state='running';
        if(t.kind==='qzone')data.autonomous.lastQzoneAttempt=now;
        if(t.chat&&!data.autonomous.contacts.some(c=>c.chat===t.chat)){
          data.autonomous.contacts.push({chat:t.chat,incomingAt:data.messages.find(m=>m.chat===t.chat&&m.id===t.messageId)?.at??0,proactiveAt:0,unanswered:0,attemptAt:0});data.autonomous.contacts=data.autonomous.contacts.slice(-5000);
        }
      });
      const a:AutonomousTurn={kind:t.kind,thoughtId:t.id,effects:new Set(),messages:0,reason:''};let failure='',busy=false;
      try {signal.throwIfAborted();busy=(await wake(t,a))===false;}catch(error){failure=String(error);}
      await this.store.update(data=>{
        const current=data.autonomous.thoughts.find(x=>x.id===t.id);
        const outcome=failure||a.failure?'unknown':busy?'pending':a.effects.has(t.kind)?'done':'dismissed';
        const reason=(failure||a.failure||a.reason||(busy?'会话正忙，保留想法稍后判断':outcome==='done'?'实际工具已完成':'这次选择保持安静')).slice(0,500);
        if(current?.state==='running'){current.state=outcome;current.result=reason;if(busy)current.due=now+interval;}
        if(!busy&&t.kind==='chat'){
          const c=data.autonomous.contacts.find(c=>c.chat===t.chat);if(c){if(a.messages||failure||a.failure)c.attemptAt=now;if(failure||a.failure)c.unanswered=1;}
          for(const other of data.autonomous.thoughts)if(other.id!==t.id&&other.state==='pending'&&other.key===`chat:${t.chat}:${t.messageId}`){other.state='dismissed';other.result='同一来源话题已判断，等待新的实际互动';}
        }
        data.autonomous.decisions.push({id:randomUUID(),thoughtId:t.id,chat:t.chat,kind:t.kind,at:now,outcome:current?.state??outcome,reason});data.autonomous.decisions=data.autonomous.decisions.slice(-500);
      });
    } finally {this.running=false;}
  }
}
