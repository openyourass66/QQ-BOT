import {withOperation,currentOperation,operationDigest} from '../core/operation-context.js';
import {redactRuntimeText} from '../core/state.js';
import type {OperationRecord} from '../storage/operation-types.js';
import type {SqliteDailyUsageStore} from '../storage/sqlite-usage-store.js';

type Options={started?:(record:OperationRecord)=>Promise<void>;finished?:(record:OperationRecord,state:'success'|'failed'|'unknown',error:string)=>Promise<void>;onProjectionFailure?:(error:Error)=>void};
const blocked=(message:string)=>Object.assign(new Error(message),{code:'OPERATION_REPLAY_BLOCKED'});

export class OperationExecutor {
  private active=new Map<string,{hash:string;promise:Promise<unknown>}>();
  private stop=new AbortController();
  constructor(private usage:SqliteDailyUsageStore,private options:Options={}){}
  get size(){return this.active.size;}
  private async project(record:OperationRecord,state:'success'|'failed'|'unknown',error:string){try{await this.options.finished?.(record,state,error);}catch(failure){this.options.onProjectionFailure?.(failure instanceof Error?failure:new Error('动作摘要保存失败'));}}
  run<T>(input:OperationRecord,signal:AbortSignal,authorize:()=>void,operation:()=>Promise<T>):Promise<T>{
    const joined=AbortSignal.any([signal,this.stop.signal]);try{joined.throwIfAborted();authorize();}catch(error){return Promise.reject(error);}
    const record=structuredClone(input),hash=operationDigest(record),existing=this.active.get(record.id);
    if(existing){if(existing.hash!==hash)return Promise.reject(blocked('相同动作编号不能替换内容。'));return existing.promise as Promise<T>;}
    if(this.active.size>=64)return Promise.reject(Object.assign(new Error('动作正在处理，请稍后重试。'),{code:'OPERATION_BUSY'}));
    const promise=(async()=>{
      const claim=await this.usage.beginOperation(record);
      if(!claim.claimed){authorize();joined.throwIfAborted();if(claim.operation.state==='completed')return structuredClone(claim.operation.result) as T;throw blocked(claim.operation.state==='failed'?'这条动作已经结束，没有再次提交；请从新的明确请求开始。':'动作正在执行或结果待核对，不会重复提交。');}
      return withOperation({record,owner:this.usage.instanceId,quotaSequence:0,stepSequence:0,signal:joined,authorize},async()=>{
        try{joined.throwIfAborted();authorize();await this.options.started?.(record);const result=await operation();await this.usage.completeOperation(record.id,result);await this.project(record,'success','');return result;}
        catch(error){const message=redactRuntimeText(String(error));let state='unknown';try{state=(await this.usage.failOperation(record.id,message)).state;}catch{}
          await this.project(record,state==='failed'?'failed':state==='completed'?'success':'unknown',message);throw error;}
      });
    })().finally(()=>{this.active.delete(record.id);});this.active.set(record.id,{hash,promise});return promise;
  }
  async remote<T>(name:string,payload:unknown,invoke:()=>Promise<T>):Promise<T>{
    const scope=currentOperation();if(!scope||scope.owner!==this.usage.instanceId)throw blocked('外部动作缺少可信执行上下文，未提交。');scope.signal.throwIfAborted();scope.authorize();
    const sequence=scope.stepSequence++,reservation=await this.usage.submitOperation(scope.record.id,sequence,name,payload);
    if(!reservation.claimed){if(reservation.state==='completed')return structuredClone(reservation.result) as T;throw blocked('动作步骤尚未确认，不会再次提交。');}
    try{
      scope.signal.throwIfAborted();scope.authorize();const result=await invoke();
      const messageId=(result as {message_id?:unknown}|null)?.message_id;if(['send_private_msg','send_group_msg'].includes(name)&&(!Number.isSafeInteger(messageId)||messageId===0))throw new Error('消息接口未返回有效编号，结果待核对，不自动重发。');
      await this.usage.finishOperationStep(scope.record.id,sequence,'completed',result);return result;
    }catch(error){await this.usage.finishOperationStep(scope.record.id,sequence,'unknown',undefined,redactRuntimeText(String(error))).catch(()=>{});throw error;}
  }
  async close(){this.stop.abort();await Promise.allSettled([...this.active.values()].map(item=>item.promise));}
}
