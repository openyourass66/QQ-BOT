import {createHash,randomUUID} from 'node:crypto';
import type {BotSettings} from '../core/settings.js';
import type {SocialData,StoredMessage} from '../qq/social-store.js';
import type {ToolContext} from '../qq/social-tools.js';
import type {SocialRepository} from '../storage/social-repository.js';
import {allowedChat} from '../qq/social-settings.js';
import {AnecdoteReviewSchema,type Anecdote,type ReviewAnecdote} from './anecdote-state.js';

const day=86400000;
const clean=(text:string)=>text.normalize('NFKC').replace(/[\p{Cf}\s]/gu,'').toLowerCase();
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const sourceHash=(m:StoredMessage)=>digest(JSON.stringify(m));
const sensitive=(text:string)=>/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.|\d{4,}|\d{1,2}[:：]\d{2}|(?:周|星期)[一二三四五六日天].*(?:去|在|见)|\d+[年月日号]|密码|口令|密钥|凭据|token|api.?key|cookie|身份证|手机号|电话号码|银行卡|转账|收款|付款|借钱|工资|收入|余额|花呗|支付宝|住址|家庭地址|定位|航班|车次|行程|医院|诊断|病历|抑郁|自杀|生病|怀孕|失恋|分手|恋爱|对象|前任|老公|老婆|男朋友|女朋友|学校|大学|公司|单位|同事|同学|老板|面试|上班|下班|考试|成绩|实名|保密|秘密|别告诉|不要告诉|不要分享|不要发|别发|聊天截图|私人照片|自拍)/iu.test(clean(text));
const optsOut=(text:string)=>/(?:别|不要|不能|不许|请勿).{0,12}(?:分享|公开|发布|发到|发说说|记住|记录|保存)|(?:保密|秘密|别告诉|不要告诉)/u.test(text.normalize('NFKC'));
const optsIn=(text:string)=>/^(?:允许|可以|恢复)(?:公开分享|分享)(?:我的)?聊天趣事[。！!\s]*$/u.test(text.trim());
const publicStyle=(text:string)=>!/(?:有人|某人|某位|群友|好友|同事|同学|用户|私聊|群聊|聊天记录|截图|昵称|原话|刚才|刚刚|QQ号|[“”「」『』])/iu.test(text);
function copied(text:string,messages:StoredMessage[]):boolean {
  const value=clean(text);return messages.filter(m=>!m.self).some(m=>{const original=clean(m.text);for(let i=0;i<=original.length-8;i++)if(value.includes(original.slice(i,i+8)))return true;return false;});
}
function named(text:string,data:SocialData,messages:StoredMessage[],s:BotSettings):boolean {
  const value=clean(text),robot=clean(s.identity.name),names=[...messages.filter(m=>!m.self).map(m=>m.name),...data.contacts.map(c=>c.name)];
  return names.some(name=>{const n=clean(name);return n.length>=2&&n!==robot&&value.includes(n);});
}
function prune(data:SocialData,now:number){
  const p=data.autonomous.anecdotePool;p.items=p.items.filter(item=>item.expires>now||item.usedAt>now-30*day).slice(-100);p.suppressed=p.suppressed.filter(item=>item.at>now-30*day).slice(-300);
}
export class Anecdotes {
  constructor(private store:SocialRepository,private settings:()=>BotSettings,private review:ReviewAnecdote,private available:()=>string=()=>'',private now=Date.now){}
  availability(){return this.available();}
  private check(ctx:ToolContext){
    ctx.signal.throwIfAborted();ctx.authorize?.();const s=this.settings();
    if(!s.social.anecdotesEnabled)throw new Error('聊天趣事分享已关闭');
    if(ctx.origin!=='message'||ctx.autonomous||ctx.proactive||ctx.reminder||ctx.messageId===undefined)throw new Error('趣事候选只能来自当前真实聊天轮次');
    if(!allowedChat(s.social,ctx.chat,ctx.user)||this.store.profile(ctx.chat)?.proactive===false)throw new Error('来源会话不允许趣事分享');
  }
  private sourcesValid(item:Anecdote,messages:StoredMessage[],data:SocialData):boolean {
    const s=this.settings(),p=data.autonomous.anecdotePool;
    return s.social.anecdotesEnabled&&item.expires>this.now()&&allowedChat(s.social,item.chat)&&data.profiles.find(p=>p.chat===item.chat)?.proactive!==false&&item.sources.every(source=>{
      const m=messages.find(m=>m.chat===item.chat&&m.id===source.id);
      return m&&!m.recalled&&sourceHash(m)===source.hash&&!p.optedOutUsers.includes(String(m.user))&&allowedChat(s.social,item.chat,m.user);
    });
  }
  async observe(chat:string,user:number,text:string,self=false):Promise<void>{
    if(self||!allowedChat(this.settings().social,chat,user)||!optsOut(text)&&!optsIn(text))return;
    await this.store.update(d=>{
      const p=d.autonomous.anecdotePool,key=String(user);
      if(optsIn(text)){p.optedOutUsers=p.optedOutUsers.filter(id=>id!==key);return;}
      if(!p.optedOutUsers.includes(key)){if(p.optedOutUsers.length>=5000)throw new Error('趣事隐私偏好已满，请先在本机整理');p.optedOutUsers.push(key);}
      for(const item of p.items)if(item.sources.some(source=>source.user===user))item.state='revoked';
    });
  }
  async propose(ctx:ToolContext,input:{text:string;topic:Anecdote['topic'];message_ids:number[]}):Promise<unknown>{
    this.check(ctx);ctx.budget??={tools:0};if(ctx.budget.anecdoteSubmitted)throw new Error('本轮已处理趣事候选，不重复审核');ctx.budget.anecdoteSubmitted=true;
    const anchor=await this.store.message(ctx.chat,ctx.messageId!);
    if(anchor.self||anchor.user!==ctx.user||anchor.recalled||this.now()-anchor.at>day)throw new Error('趣事来源已失效');
    const recent=await this.store.messages(ctx.chat,24),index=recent.findIndex(m=>m.id===anchor.id);
    if(index<0)throw new Error('趣事来源不在近期记录中');
    const context=recent.slice(Math.max(0,index-9),index+1).filter(m=>m.at>=this.now()-day);
    if(!input.message_ids.includes(anchor.id)||input.message_ids.some(id=>!context.some(m=>m.id===id)))throw new Error('请使用当前及近期会话的真实消息编号');
    const data=this.store.view('autonomous','contacts','profiles'),pool=data.autonomous.anecdotePool;
    if(context.some(m=>m.recalled||pool.optedOutUsers.includes(String(m.user))||!allowedChat(this.settings().social,ctx.chat,m.user)||!m.segments.every(s=>['text','reply','at'].includes(s.type))||sensitive(m.text)||optsOut(m.text)||named(m.text,data,context,this.settings())))return {saved:false,reason:'来源含敏感内容、身份线索、媒体或不公开偏好，不提取趣事'};
    const candidate=input.text.trim(),hash=digest(clean(candidate));
    if(sensitive(candidate)||!publicStyle(candidate)||named(candidate,data,context,this.settings())||copied(candidate,context))return {saved:false,reason:'候选存在隐私、原话或叙事线索，不入库'};
    if(context.reduce((n,m)=>n+m.text.length,0)>10000)return {saved:false,reason:'来源材料超过审核预算，不截断审核'};
    if(pool.suppressed.some(x=>x.hash===hash||input.message_ids.some(id=>x.hash===digest('source:'+ctx.chat+':'+id)))||pool.items.some(x=>x.hash===hash||x.chat===ctx.chat&&x.sources.some(source=>input.message_ids.includes(source.id))))return {saved:false,reason:'这段趣事已整理、使用或删除，不重复提取'};
    const unavailable=this.available();if(unavailable)return {saved:false,reason:unavailable};
    const reviewed=AnecdoteReviewSchema.parse(await this.review({candidate,topic:input.topic,messages:context.map(m=>({self:m.self,text:m.text}))},ctx.signal));
    this.check(ctx);
    if(!reviewed.safe||!reviewed.grounded||reviewed.identifiable||reviewed.sensitive||reviewed.verbatim||reviewed.text.length<8||sensitive(reviewed.text)||!publicStyle(reviewed.text)||named(reviewed.text,data,context,this.settings())||copied(reviewed.text,context))return {saved:false,reason:'独立隐私审核未通过，不入库'};
    const resultHash=digest(clean(reviewed.text)),sources=context.map(m=>({id:m.id,user:m.user,hash:sourceHash(m)}));
    const item:Anecdote={id:randomUUID(),hash:resultHash,chat:ctx.chat,text:reviewed.text,topic:reviewed.topic,sources,at:this.now(),expires:this.now()+7*day,state:'ready',usedAt:0};
    return this.store.updateWithMessages(ctx.chat,sources.map(s=>s.id),d=>{
      this.check(ctx);prune(d,this.now());
      if(!this.sourcesValid(item,d.messages,d)||named(item.text,d,context,this.settings()))throw new Error('审核期间来源、隐私偏好或会话权限变化，候选未入库');
      const p=d.autonomous.anecdotePool;
      if(p.suppressed.some(x=>x.hash===hash||x.hash===resultHash||input.message_ids.some(id=>x.hash===digest('source:'+ctx.chat+':'+id)))||p.items.some(x=>x.hash===resultHash||x.chat===ctx.chat&&x.sources.some(source=>input.message_ids.includes(source.id))))return {saved:false,reason:'素材已被处理，不重复入库'};
      if(p.items.length>=100)p.items.shift();p.items.push(item);return {saved:true,id:item.id};
    });
  }
  async publicMaterials(signal:AbortSignal):Promise<Array<{id:string;text:string;topic:Anecdote['topic']}>>{
    if(!this.settings().social.anecdotesEnabled)return [];
    const data=this.store.view('autonomous','contacts','profiles'),items=data.autonomous.anecdotePool.items;
    const lastTopic=[...items].filter(i=>i.usedAt>this.now()-day).sort((a,b)=>b.usedAt-a.usedAt)[0]?.topic,result:Array<{id:string;text:string;topic:Anecdote['topic']}>=[];
    for(const item of [...items].reverse()){
      signal.throwIfAborted();if(item.state!=='ready'||item.topic===lastTopic||named(item.text,data,[],this.settings()))continue;
      const messages=await this.store.lookupMessages(item.sources.map(s=>({chat:item.chat,id:s.id})));
      const fresh=this.store.view('autonomous','contacts','profiles'),current=fresh.autonomous.anecdotePool.items.find(i=>i.id===item.id);
      if(!current||current.state!=='ready'||current.hash!==item.hash||named(current.text,fresh,[],this.settings())||!this.sourcesValid(current,messages,fresh))continue;
      result.push({id:item.id,text:item.text,topic:item.topic});if(result.length>=6)break;
    }
    return result;
  }
  async publicationGuard(ctx:ToolContext,text:string,id?:string):Promise<void>{
    if(ctx.autonomous?.kind!=='qzone'){if(id)throw new Error('趣事素材仅供独立自主说说使用');return;}
    ctx.signal.throwIfAborted();const data=this.store.view('autonomous','contacts','profiles');
    if(sensitive(text)||!publicStyle(text)||named(text,data,[],this.settings()))throw new Error('自主说说含隐私或人物线索，未发布');
    if(!id){const value=clean(text);if(data.autonomous.anecdotePool.suppressed.some(s=>s.hash===digest(value))||data.autonomous.anecdotePool.items.some(item=>{const source=clean(item.text);for(let n=0;n<=source.length-8;n++)if(value.includes(source.slice(n,n+8)))return true;return false;}))throw new Error('使用趣事文案必须填写本轮提供的 anecdote_id，不能绕过素材有效性检查');return;}
    if(!ctx.autonomous.publicAnecdoteIds?.includes(id))throw new Error('只能使用本轮提供的已审核趣事素材');
    const item=data.autonomous.anecdotePool.items.find(i=>i.id===id);
    if(!item||item.state!=='ready'||text.trim()!==item.text)throw new Error('趣事素材已使用、删除或正文被扩写，请使用已审核原文');
    await this.store.updateWithMessages(item.chat,item.sources.map(s=>s.id),d=>{
      ctx.signal.throwIfAborted();const current=d.autonomous.anecdotePool.items.find(i=>i.id===id);
      if(!current||current.state!=='ready'||current.text!==text.trim()||!this.sourcesValid(current,d.messages,d))throw new Error('趣事素材已失效、撤回或不允许公开，未发布');
      current.state='used';current.usedAt=this.now();
    });
    ctx.autonomous.reservedAnecdoteId=id;
  }
  assertPublication(ctx:ToolContext,text:string,id?:string):void {
    if(ctx.autonomous?.kind!=='qzone'||!id)return;
    const data=this.store.view('autonomous','profiles'),item=data.autonomous.anecdotePool.items.find(i=>i.id===id),s=this.settings();
    if(!s.social.anecdotesEnabled||!item||item.expires<=this.now()||item.text!==text.trim()||!ctx.autonomous.publicAnecdoteIds?.includes(id)||item.state==='revoked'||item.state==='used'&&ctx.autonomous.reservedAnecdoteId!==id||data.profiles.find(p=>p.chat===item.chat)?.proactive===false||!allowedChat(s.social,item.chat)||item.sources.some(source=>data.autonomous.anecdotePool.optedOutUsers.includes(String(source.user))||!allowedChat(s.social,item.chat,source.user)))throw new Error('趣事来源权限、保密偏好或素材状态已变化，未继续发布');
  }
}

export function deleteAnecdote(data:SocialData,id:string,now=Date.now()):void {
  const pool=data.autonomous.anecdotePool,item=pool.items.find(i=>i.id===id);if(!item)throw new Error('趣事素材不存在');
  pool.suppressed.push({hash:item.hash,at:now},...item.sources.map(s=>({hash:digest('source:'+item.chat+':'+s.id),at:now})));
  pool.suppressed=pool.suppressed.filter(s=>s.at>now-30*day).slice(-300);pool.items=pool.items.filter(i=>i.id!==id);
}
