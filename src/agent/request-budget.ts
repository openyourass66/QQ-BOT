import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {BotSettings} from '../core/settings.js';
import type {Quota} from '../core/usage.js';
import type {ModelRequestRecord,ReportedUsage} from '../storage/database-types.js';
import type {ServiceRequest,PreparedServiceRequest} from './service-request.js';

export class ModelBudgetError extends Error {readonly code='MODEL_BUDGET_EXCEEDED';}
export type RequestScope={chat:string;user:string;background:boolean;signal:AbortSignal;allowed:()=>boolean;sessionId?:string};
type Binding={scope:RequestScope;turn:string;requests:number;closed:boolean};
type Lease={binding:Binding;record:ModelRequestRecord;id:string;timer?:NodeJS.Timeout};
type RequestUsage={reserveModel:(record:ModelRequestRecord,getQuotas:()=>Quota[])=>Promise<{reused:boolean}>;finishModel:(id:string,outcome:'completed'|'failed'|'unknown',usage:ReportedUsage)=>Promise<unknown>};
export type ReserveRequest={sessionId:string;id:string;kind:ModelRequestRecord['kind'];provider:string;model:string;bytes:number;maxOutputTokens?:number};
export class RequestBudget {
  private bindings=new Map<string,Binding>();
  private leases=new Map<string,Lease>();
  private completed=new Set<string>();
  private recent:Array<{id:string;at:number}>=[];
  private closed=false;
  constructor(private usage:RequestUsage,private settings:()=>BotSettings,private options:{now?:()=>number;onHung?:()=>void;graceMs?:number}={}){}
  get active(){return this.leases.size;}
  bind(sessionId:string,scope:RequestScope):()=>void {
    if(this.closed||this.bindings.has(sessionId)||this.bindings.size>=64)throw new ModelBudgetError('模型请求上下文不可用，请等待当前任务结束。');
    const binding:Binding={scope,turn:randomUUID(),requests:0,closed:false};this.bindings.set(sessionId,binding);
    return ()=>{if(binding.closed)return;binding.closed=true;if(this.bindings.get(sessionId)===binding)this.bindings.delete(sessionId);for(const lease of this.leases.values())if(lease.binding===binding&&!lease.timer){lease.timer=setTimeout(()=>this.options.onHung?.(),this.options.graceMs??5000);lease.timer.unref();}};
  }
  private binding(sessionId:string):Binding {
    const binding=this.bindings.get(sessionId);if(this.closed||!binding||binding.closed||binding.scope.signal.aborted)throw new ModelBudgetError('当前模型轮次已结束或被取消，请求未提交。');
    try{if(!binding.scope.allowed())throw new Error();}catch{throw new ModelBudgetError('当前会话或能力已关闭，请求未提交。');}return binding;
  }
  limits(sessionId:string){this.binding(sessionId);const settings=this.settings();return {...settings.requests,toolsPerTurn:settings.context.toolsPerTurn};}
  async reserve(request:ReserveRequest){
    const binding=this.binding(request.sessionId),settings=this.settings(),limits=settings.requests;
    if(!/^[a-zA-Z0-9-]{8,128}$/.test(request.id)||typeof request.provider!=='string'||request.provider.length>256||typeof request.model!=='string'||request.model.length>256||!Number.isSafeInteger(request.bytes)||request.bytes<0||request.bytes>limits.maxRequestKiB*1024)throw new ModelBudgetError('模型请求材料超过上限或参数无效，请缩小本轮材料。');
    if(this.leases.has(request.id)||this.completed.has(request.id))throw new ModelBudgetError('该模型请求编号已使用，不会重复提交。');
    if(binding.requests>=limits.perTurn)throw new ModelBudgetError('本轮模型请求预算已用完，已停止继续请求。');
    if(this.leases.size>=limits.concurrent)throw new ModelBudgetError('模型请求并发已满，请稍后再试。');
    const now=(this.options.now??(()=>performance.now()))();this.recent=this.recent.filter(item=>now-item.at<60000);
    if(this.recent.length>=limits.perMinute)throw new ModelBudgetError('模型请求过于频繁，请稍后再试。');
    const output=request.maxOutputTokens??(['conversation','compaction'].includes(request.kind)?0:['speech','transcription','search','fetch'].includes(request.kind)?0:limits.maxOutputTokens);
    if(!Number.isSafeInteger(output)||output<0||output>limits.maxOutputTokens||(['conversation','compaction'].includes(request.kind)&&!output))throw new ModelBudgetError('模型请求未遵守输出上限，已停止提交；请重新连接受管模型。');
    const record:ModelRequestRecord={id:request.id,turn:binding.turn,kind:request.kind,background:binding.scope.background,chat:binding.scope.chat,user:binding.scope.user,provider:request.provider,model:request.model,maxOutputTokens:output};
    const lease:Lease={binding,record,id:request.id};this.leases.set(request.id,lease);binding.requests++;const rate={id:request.id,at:now};this.recent.push(rate);
    try{
      const saved=await this.usage.reserveModel(record,()=>{
        this.binding(request.sessionId);const s=this.settings(),q=s.requests;
        return [{key:'service-requests',amount:1,limit:q.perDay,label:'模型与能力请求'},
          {key:'service-chat:'+binding.scope.chat,amount:1,limit:q.perChatPerDay,label:'当前会话服务请求'},
          ...(binding.scope.background?[{key:'service-background',amount:1,limit:q.backgroundPerDay,label:'后台服务请求'}]:[{key:'service-user:'+binding.scope.user,amount:1,limit:q.perUserPerDay,label:'当前用户服务请求'}]),
          ...(['vision','speech','transcription'].includes(request.kind)?[{key:'service-media',amount:1,limit:q.mediaPerDay,label:'独立媒体服务'}]:[]),
          ...(request.kind==='learning'?[{key:'learning',amount:1,limit:s.learning.dailyCalls,label:'后台学习'}]:[]),
          ...(['search','fetch'].includes(request.kind)?[{key:'native-web',amount:1,limit:q.nativeWebPerDay,label:'原生联网'}]:[])] as Quota[];
      });
      if(saved.reused){this.completed.add(request.id);throw new ModelBudgetError('该模型请求已经预扣，不会再次提交外部服务。');}
      let latest;
      try{latest=this.limits(request.sessionId);if(output>latest.maxOutputTokens||request.bytes>latest.maxRequestKiB*1024||binding.requests>latest.perTurn||[...this.leases.keys()].indexOf(request.id)>=latest.concurrent)throw new ModelBudgetError('请求排队期间预算已调整，本次请求未提交。');}catch(error){await this.usage.finishModel(request.id,'unknown',{inputTokens:null,outputTokens:null});throw error;}
      return {id:request.id,maxOutputTokens:output,maxResponseChars:latest.maxResponseChars,maxRequestKiB:latest.maxRequestKiB};
    }catch(error){this.leases.delete(request.id);if(lease.timer)clearTimeout(lease.timer);binding.requests--;this.recent=this.recent.filter(item=>item!==rate);if((error as {code?:string}).code==='DATABASE_QUOTA_EXCEEDED')throw new ModelBudgetError('今天的模型或能力请求额度已用完，请等额度恢复或由主人调整。');throw error;}
  }
  async finish(id:string,outcome:'completed'|'failed'|'unknown',usage:ReportedUsage){
    const lease=this.leases.get(id);if(!lease&&!this.completed.has(id))throw new ModelBudgetError('模型请求记录不属于当前运行实例。');
    await this.usage.finishModel(id,outcome,usage);if(lease?.timer)clearTimeout(lease.timer);this.leases.delete(id);this.completed.add(id);if(this.completed.size>1000)this.completed.delete(this.completed.values().next().value!);return {recorded:true};
  }
  async prepareService(input:ServiceRequest,scope:RequestScope):Promise<PreparedServiceRequest>{
    const available=()=>{input.signal.throwIfAborted();scope.signal.throwIfAborted();if(!scope.allowed())throw new ModelBudgetError('当前会话或能力已关闭，请求未提交。');};
    available();const sessionId=scope.sessionId??'service-'+randomUUID(),unbind=scope.sessionId?()=>{}:this.bind(sessionId,scope),id=randomUUID();let attempted=false,started=false,reservedId=false,report:ReportedUsage={inputTokens:null,outputTokens:null};
    const settle=async(outcome:'completed'|'unknown')=>{if(attempted)return;attempted=true;await this.finish(id,outcome,report);};
    try{
      const cap=this.settings().requests.maxOutputTokens,maxOutputTokens=['speech','transcription'].includes(input.kind)?0:Math.min(input.maxOutputTokens??cap,cap);
      const reserved=await this.reserve({sessionId,id,kind:input.kind,provider:input.kind==='learning'?'learning-service':'media-service',model:input.model,bytes:input.bytes,maxOutputTokens});
      reservedId=true;available();
      return {run:async operation=>{
        if(started||attempted)throw new ModelBudgetError('同一服务请求不能重复提交');started=true;
        try{available();const current=this.limits(sessionId);if(reserved.maxOutputTokens>current.maxOutputTokens||input.bytes>current.maxRequestKiB*1024)throw new ModelBudgetError('服务请求预算已调整，请重新发起');const value=await operation({maxOutputTokens:reserved.maxOutputTokens,maxResponseChars:current.maxResponseChars},usage=>{report=usage;});await settle('completed');return value;}
        catch(error){await settle('unknown');throw error;}
      },close:async()=>{try{await settle('unknown');}finally{unbind();}}};
    }catch(error){try{if(reservedId)await settle('unknown');}finally{unbind();}throw error;}
  }
  close(){this.closed=true;this.bindings.clear();for(const lease of this.leases.values())if(lease.timer)clearTimeout(lease.timer);}
}
