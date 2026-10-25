import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MemoryMetaSchema } from './cognition-state.js';
import type { BotSettings } from './settings.js';
import { allowedChat } from './social-settings.js';
import type { SocialData, SocialStore, StoredMessage } from './social-store.js';
import type { DailyUsageStore } from './usage.js';

const evidence = z.object({messageId:z.number().int().safe(),quote:z.string().trim().min(2).max(500)}).strict();
export const LearningProposalSchema = z.object({
  memories:z.array(z.object({user:z.string().regex(/^\d+$/),text:z.string().trim().min(2).max(300),
    evidence:z.array(evidence).min(1).max(10),replaceId:z.string().optional()}).strict()).max(12).default([]),
  lexicon:z.array(z.object({term:z.string().trim().min(1).max(40),meaning:z.string().trim().min(1).max(300),
    kind:z.enum(['term','expression']),evidence:z.array(evidence).min(3).max(20)}).strict()).max(8).default([]),
}).strict();
export type LearningProposal = z.infer<typeof LearningProposalSchema>;
export type LearningBatch = {chat:string;messages:StoredMessage[];memories:SocialData['memories'];revision:string};
export type Analyze = (batch:LearningBatch,signal:AbortSignal)=>Promise<LearningProposal|{proposal:LearningProposal;usage?:{inputTokens:number;outputTokens:number}} >;
export const normalize = (value:string):string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
export const fingerprint = (value:string):string => createHash('sha256').update(normalize(value)).digest('hex');
const unsafe = (text:string):boolean => /(?:api[_ -]?key|access[_ -]?token|authorization|password|密码|密钥|口令|cookie)\s*[:=：]|(?:sk-|Bearer\s+)[a-z0-9_-]{10,}|-----BEGIN .*PRIVATE KEY/i.test(text);
const quotedOrOptOut = (text:string):boolean => /不要(?:记|保存|学)|别(?:记|保存|学)|请勿|忘记|假如|假设|比如|举例|开玩笑|他说|她说|转述|引用/.test(text);
function supportsAssertion(text:string,quote:string):boolean {
  const q=normalize(quote),t=normalize(text),index=q.indexOf(t);if(!t||index<0)return false;
  return /^(?:我|本人|自己|一直|比较|很|现在|以前|目前|平时|最近|经常|确实|其实|真的|非常)*$/.test(q.slice(0,index))&&/^(?:的|呢|啊|了|哦)*$/.test(q.slice(index+t.length));
}
function terms(text:string):Set<string> {
  const set=new Set(text.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)??[]);
  for(const run of [...set]) if(/\p{Script=Han}/u.test(run))for(let i=0;i<run.length-1;i++)set.add(run.slice(i,i+2));
  return set;
}
function related(text:string,query:Set<string>):number {let score=0;for(const word of query)if(text.toLocaleLowerCase().includes(word))score+=word.length>2?3:1;return score;}
function bounded(lines:string[],count:number,chars:number):string {const result:string[]=[];let size=0;for(const line of lines){if(result.length>=count)break;if(size+line.length>chars)continue;result.push(line);size+=line.length+1;}return result.join('\n');}
function visibleSources(data:SocialData,chat:string,ids:number[],settings:BotSettings,snapshots:Array<{id:number;user:string}>=[]):boolean {
  return ids.every(id=>{const m=data.messages.find(m=>m.chat===chat&&m.id===id);return m?!m.self&&!m.recalled&&!settings.social.blockedUsers.includes(String(m.user)):snapshots.some(e=>e.id===id&&!settings.social.blockedUsers.includes(e.user));});
}
export function memoryMeta(data:SocialData,id:string) {return data.cognition.memories[id]??MemoryMetaSchema.parse({});}
export function cognitionRevision(data:SocialData,chat:string):string {
  return fingerprint(JSON.stringify({memories:data.memories.filter(m=>m.chat===chat).map(m=>[m,data.cognition.memories[m.id]]),lexicon:data.cognition.lexicon.filter(l=>l.chat===chat),suppressed:data.cognition.suppressed.filter(s=>s.chat===chat)}));
}
export function recall(data:SocialData,settings:BotSettings,chat:string,user:string,query:string,now=Date.now()):{memories:string;lexicon:string} {
  if(!allowedChat(settings.social,chat,user))return {memories:'',lexicon:''};
  const words=terms(query), cfg=settings.learning;
  const memories=settings.social.memoryEnabled?data.memories.filter(m=>{
    const meta=memoryMeta(data,m.id);
    return m.chat===chat&&!settings.social.blockedUsers.includes(m.user)&&meta.status==='active'&&(!meta.expiresAt||meta.expiresAt>now)&&
      (!meta.sources.length||visibleSources(data,chat,meta.sources,settings,meta.evidence));
  }).map(m=>({m,score:(m.user===user?25:0)+related(m.text,words)+(memoryMeta(data,m.id).locked?2:0)}))
    .sort((a,b)=>b.score-a.score||b.m.at-a.m.at).map(({m})=>`${m.name}(QQ ${m.user}): ${m.text}`):[];
  const lexicon=settings.learning.useLexicon&&chat.startsWith('group:')?data.cognition.lexicon.filter(l=>l.chat===chat&&l.status==='active'&&
    (l.locked||visibleSources(data,chat,l.sources,settings,l.evidence))).map(l=>({l,score:related(l.term,words)+(query.includes(l.term)?20:0)}))
    .filter(v=>v.score>0).sort((a,b)=>b.score-a.score).map(({l})=>`${l.kind==='expression'?'表达参考':'群内用语'}「${l.term}」：${l.meaning}`):[];
  return {memories:bounded(memories,cfg.memoryCount,cfg.memoryChars),lexicon:bounded(lexicon,cfg.lexiconCount,cfg.lexiconChars)};
}

export function reviseMemory(data:SocialData,id:string,text:string,reason='管理员编辑',now=Date.now()):void {
  const item=data.memories.find(m=>m.id===id);if(!item)throw new Error('记忆不存在');
  const meta=memoryMeta(data,id);meta.history.push({text:item.text,at:now,reason});meta.history=meta.history.slice(-10);
  if(normalize(item.text)!==normalize(text)){data.cognition.suppressed.push({chat:item.chat,hash:fingerprint(item.text),at:now});data.cognition.suppressed=data.cognition.suppressed.slice(-10000);}
  item.text=text;meta.source='admin';meta.locked=true;meta.status='active';meta.confidence='confirmed';meta.revision++;meta.confirmedAt=now;meta.sources=[];meta.evidence=[];
  data.cognition.memories[id]=meta;
}
export function forgetMemory(data:SocialData,id:string,now=Date.now()):void {
  const item=data.memories.find(m=>m.id===id);if(!item)throw new Error('记忆不存在');
  data.cognition.suppressed.push({chat:item.chat,hash:fingerprint(item.text),at:now});data.cognition.suppressed=data.cognition.suppressed.slice(-10000);
  data.memories=data.memories.filter(m=>m.id!==id);delete data.cognition.memories[id];
}

/** Analysis returns proposals only. The single store writer validates a fresh snapshot before committing. */
export class Cognition {
  private running?:Promise<void>;
  constructor(readonly store:SocialStore,private settings:()=>BotSettings,private usage:DailyUsageStore,private analyze:Analyze,
    private available:()=>string=()=>'',private now:()=>number=Date.now) {}
  availability():string {return this.available();}
  review(chat:string,signal:AbortSignal):Promise<void> {
    if(this.running)throw new Error('已有资料整理正在执行，请稍后再试');
    const data=this.store.snapshot(),s=this.settings();
    const messages=data.messages.filter(m=>m.chat===chat&&!m.self&&!m.recalled&&!s.social.blockedUsers.includes(String(m.user))&&m.segments.every(v=>['text','at','reply','face'].includes(v.type))&&!unsafe(m.text)&&!quotedOrOptOut(m.text)).slice(-80);
    if(!messages.length)throw new Error('当前会话没有可整理的有效文字消息');
    this.running=this.run({chat,messages,memories:data.memories.filter(m=>m.chat===chat&&!s.social.blockedUsers.includes(m.user)),revision:cognitionRevision(data,chat)},signal).finally(()=>{this.running=undefined;});return this.running;
  }
  tick(signal:AbortSignal,busy:()=>boolean):Promise<void> {
    if(this.running||signal.aborted||busy())return Promise.resolve();
    this.running=this.scan(signal,busy).finally(()=>{this.running=undefined;});return this.running;
  }
  async flush():Promise<void> {await this.running;}
  private async scan(signal:AbortSignal,busy:()=>boolean):Promise<void> {
    const s=this.settings(),cfg=s.learning;if((!cfg.memory&&!cfg.lexicon)||!cfg.dailyCalls||this.usage.used('learning')>=cfg.dailyCalls||this.available())return;
    const data=this.store.snapshot(),now=this.now();
    for(const chat of cfg.chats) {
      if(busy()||signal.aborted)return;
      if(!allowedChat(s.social,chat)||!cfg.memory&&!chat.startsWith('group:'))continue;
      const scope=data.cognition.scopes[chat]??{cursor:0,cursorIds:[],lastAttempt:0};
      if(now-scope.lastAttempt<cfg.intervalMinutes*60000)continue;
      const all=data.messages.filter(m=>m.chat===chat&&!m.self&&!m.recalled&&!s.social.blockedUsers.includes(String(m.user)));
      if(!all.length||now-all.at(-1)!.at<cfg.idleMinutes*60000)continue;
      const messages=all.filter(m=>(m.at>scope.cursor||m.at===scope.cursor&&!scope.cursorIds.includes(m.id))&&m.segments.every(v=>['text','at','reply','face'].includes(v.type))&&!unsafe(m.text)&&!quotedOrOptOut(m.text)).slice(0,Math.max(80,cfg.minMessages));
      if(messages.length<cfg.minMessages)continue;
      await this.run({chat,messages,memories:data.memories.filter(m=>m.chat===chat&&!s.social.blockedUsers.includes(m.user)),revision:cognitionRevision(data,chat)},signal);break;
    }
  }
  async run(batch:LearningBatch,signal:AbortSignal):Promise<void> {
    const current=this.settings();if(!current.learning.chats.includes(batch.chat)||!allowedChat(current.social,batch.chat))throw new Error('当前会话未开启学习');
    if(!current.learning.memory&&!current.learning.lexicon)throw new Error('后台学习已关闭');
    if(this.available())throw new Error(this.available());
    signal.throwIfAborted();
    await this.usage.consume(()=>[{key:'learning',amount:1,limit:this.settings().learning.dailyCalls,label:'后台学习'}]);
    const id=randomUUID(),at=this.now();
    await this.store.update(d=>{
      const scope=d.cognition.scopes[batch.chat]??{cursor:0,cursorIds:[],lastAttempt:0};
      const next=Math.max(scope.cursor,...batch.messages.map(m=>m.at));
      scope.cursorIds=[...new Set([...(scope.cursor===next?scope.cursorIds:[]),...batch.messages.filter(m=>m.at===next).map(m=>m.id)])].slice(-20000);
      scope.cursor=next;scope.lastAttempt=at;d.cognition.scopes[batch.chat]=scope;
      d.cognition.jobs.push({id,chat:batch.chat,at,state:'running',summary:'分析中',sources:batch.messages.map(m=>m.id)});d.cognition.jobs=d.cognition.jobs.slice(-200);
    });
    try {
      const analyzed=await this.analyze(batch,signal),proposal=LearningProposalSchema.parse('proposal' in analyzed?analyzed.proposal:analyzed);signal.throwIfAborted();
      await this.store.update(d=>{
        const job=d.cognition.jobs.find(j=>j.id===id)!;
        if('proposal' in analyzed&&analyzed.usage){job.inputTokens=analyzed.usage.inputTokens;job.outputTokens=analyzed.usage.outputTokens;}
        const s=this.settings();
        if(!s.learning.chats.includes(batch.chat)||!allowedChat(s.social,batch.chat)||batch.revision!==cognitionRevision(d,batch.chat)) {
          job.state='discarded';job.summary='设置或记忆已修改，未应用本次提案';return;
        }
        let added=0,lexicon=0;
        const sources=(items:z.infer<typeof evidence>[],user?:string):StoredMessage[]=>{
          const ids=new Set<number>();return items.map(e=>{
            const before=batch.messages.find(m=>m.id===e.messageId),m=d.messages.find(m=>m.chat===batch.chat&&m.id===e.messageId);
            if(ids.has(e.messageId)||!m||!before||m.text!==before.text||m.user!==before.user||m.self||m.recalled||s.social.blockedUsers.includes(String(m.user))||
              (user&&String(m.user)!==user)||unsafe(m.text)||quotedOrOptOut(m.text)||!normalize(m.text).includes(normalize(e.quote)))throw new Error('提案来源无效');
            const beforeQuote=normalize(m.text).slice(0,normalize(m.text).indexOf(normalize(e.quote))).slice(-8);
            if(/[不没无非否别勿莫]$/.test(beforeQuote)||/不是|不代表|不等于/.test(beforeQuote))throw new Error('来源存在否定或解释语境');
            ids.add(m.id);return m;
          });
        };
        if(s.learning.memory&&s.social.memoryEnabled)for(const p of proposal.memories) {
          let records:StoredMessage[];try{records=sources(p.evidence,p.user);}catch{continue;}
          if(normalize(p.text).length<2||unsafe(p.text)||!p.evidence.some(e=>supportsAssertion(p.text,e.quote)))continue;
          const suppressed=d.cognition.suppressed.find(v=>v.chat===batch.chat&&v.hash===fingerprint(p.text));
          if(suppressed&&records.every(m=>m.at<=suppressed.at))continue;
          const duplicate=d.memories.find(m=>m.chat===batch.chat&&m.user===p.user&&normalize(m.text)===normalize(p.text));
          if(duplicate){const meta=memoryMeta(d,duplicate.id);if(!meta.locked){meta.confirmedAt=at;const evidence=new Map(meta.evidence.map(e=>[e.id,e]));for(const m of records)evidence.set(m.id,{id:m.id,user:String(m.user),quote:p.evidence.find(e=>e.messageId===m.id)!.quote,at:m.at});meta.evidence=[...evidence.values()].slice(-20);meta.sources=meta.evidence.map(e=>e.id);meta.revision++;d.cognition.memories[duplicate.id]=meta;}continue;}
          if(d.memories.length>=10000)break;
          const old=p.replaceId?d.memories.find(m=>m.id===p.replaceId&&m.chat===batch.chat&&m.user===p.user):undefined;
          if(p.replaceId&&!old)continue;
          const oldMeta=old?memoryMeta(d,old.id):undefined;
          if(oldMeta?.locked)continue;
          const mid=randomUUID();d.memories.push({id:mid,chat:batch.chat,user:p.user,name:records[0].name,text:p.text,at});
          d.cognition.memories[mid]=MemoryMetaSchema.parse({source:'learned',sources:records.map(m=>m.id),locked:false,confirmedAt:at,
            confidence:'supported',evidence:records.map(m=>({id:m.id,user:String(m.user),quote:p.evidence.find(e=>e.messageId===m.id)!.quote,at:m.at})),
            status:old?'conflict':'active',history:old?[{text:old.text,at,reason:'新旧记录待管理员确认'}]:[]});
          if(old&&oldMeta){oldMeta.status='conflict';oldMeta.revision++;d.cognition.memories[old.id]=oldMeta;}
          added++;
        }
        if(s.learning.lexicon&&batch.chat.startsWith('group:'))for(const p of proposal.lexicon){
          let records:StoredMessage[];try{records=sources(p.evidence);}catch{continue;}
          if(!normalize(p.term)||unsafe(p.meaning)||unsafe(p.term)||records.length<3||new Set(records.map(m=>m.user)).size<2||records.some(m=>!normalize(m.text).includes(normalize(p.term))))continue;
          if(d.cognition.suppressed.some(v=>v.chat===batch.chat&&v.hash===fingerprint(p.term)&&records.every(m=>m.at<=v.at)))continue;
          const old=d.cognition.lexicon.find(l=>l.chat===batch.chat&&normalize(l.term)===normalize(p.term));
          if(old?.locked||old?.status==='disabled')continue;
          if(old){const evidence=new Map(old.evidence.map(e=>[e.id,e]));for(const m of records)evidence.set(m.id,{id:m.id,user:String(m.user),quote:p.evidence.find(e=>e.messageId===m.id)!.quote,at:m.at});old.evidence=[...evidence.values()].slice(-20);old.sources=old.evidence.map(e=>e.id);if(old.meaning!==p.meaning){old.history.push({text:old.meaning,at,reason:'新解释待核对'});old.history=old.history.slice(-10);old.meaning=p.meaning;old.status='candidate';old.revision++;}}
          else if(d.cognition.lexicon.length<3000)d.cognition.lexicon.push({id:randomUUID(),chat:batch.chat,term:p.term,meaning:p.meaning,kind:p.kind,sources:records.map(m=>m.id),evidence:records.map(m=>({id:m.id,user:String(m.user),quote:p.evidence.find(e=>e.messageId===m.id)!.quote,at:m.at})),status:'candidate',locked:false,revision:1,at,history:[]});
          lexicon++;
        }
        job.state='completed';job.summary=`新增记忆 ${added} 条；用语候选 ${lexicon} 条（需在管理端确认）`;
      });
    } catch(error) {
      await this.store.update(d=>{const j=d.cognition.jobs.find(j=>j.id===id);if(j){j.state=signal.aborted?'unknown':'failed';j.summary=signal.aborted?'分析已中止，未写入提案':'分析失败或返回格式无效，未写入提案';}});
      if(signal.aborted)throw error;
    }
  }
}
