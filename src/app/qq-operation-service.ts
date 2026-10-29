import {randomUUID} from 'node:crypto';
import type {BotSettings} from '../core/settings.js';
import {currentOperation,operationDigest} from '../core/operation-context.js';
import type {SqliteDailyUsageStore} from '../storage/sqlite-usage-store.js';
import type {SocialRepository} from '../storage/social-repository.js';
import type {OperationRecord} from '../storage/operation-types.js';
import type {ToolContext} from '../qq/social-tools.js';
import type {OneBotInvocation} from '../qq/onebot.js';
import {allowedChat} from '../qq/social-settings.js';
import {assertProtocolOperation,protocolMutation} from '../security/protocol-policy.js';
import {OperationExecutor} from './operation-executor.js';

type Options={settings:()=>BotSettings;account:()=>number;readAccount:(signal:AbortSignal)=>Promise<number>;stopping:()=>boolean;fatal:(error:Error)=>void};
export class QqOperationService {
  readonly executor:OperationExecutor;
  constructor(private usage:SqliteDailyUsageStore,private store:SocialRepository,private options:Options){
    this.executor=new OperationExecutor(usage,{started:async record=>{await store.beginAction(record.chat,record.tool);},finished:async(record,state,error)=>{await store.endAction(record.id,state,error||record.summary);},onProjectionFailure:options.fatal});
  }
  key(ctx:ToolContext):string {
    if(!ctx.operationKey)ctx.operationKey=operationDigest(ctx.messageId!==undefined?['message',ctx.self,ctx.chat,ctx.user,ctx.messageId,ctx.sourceTime??0]:['turn',ctx.self,ctx.chat,ctx.autonomous?.thoughtId??'',ctx.autonomous?.runId??randomUUID()]);return ctx.operationKey;
  }
  run<T>(ctx:ToolContext,tool:string,payload:unknown,summary:string,authorize:()=>void,operation:()=>Promise<T>,trace?:string):Promise<T>{
    const parent=currentOperation();if(parent){if(parent.record.account!==ctx.self)throw new Error('嵌套动作账号与当前执行记录不一致');return operation();}const turn=this.key(ctx),id=operationDigest([turn,trace??['effect',ctx.operationSequence??0]]);if(trace===undefined)ctx.operationSequence=(ctx.operationSequence??0)+1;
    const record:OperationRecord={id,turn,account:ctx.self,chat:ctx.chat,user:String(ctx.user),origin:ctx.origin??(ctx.reminder||ctx.proactive?'background':'message'),tool,payload,summary:summary.slice(0,500)};
    return this.executor.run(record,ctx.signal,()=>{ctx.signal.throwIfAborted();if(this.options.stopping())throw new Error('机器人正在停止，动作未继续提交。');authorize();},operation);
  }
  private target(record:OperationRecord,call:OneBotInvocation):void {
    const s=this.options.settings(),p=call.params;assertProtocolOperation(record,call.action);
    if(this.store.view('account').account!==record.account)throw Object.assign(new Error('QQ 账号与动作记录不匹配，未提交。'),{code:'ACCOUNT_CHANGED'});
    if(record.tool==='system_notice'&&record.payload&&typeof record.payload==='object'&&['approval','approval-help'].includes(String((record.payload as {kind?:string}).kind))){
      if(call.action!=='send_private_msg'||Number(p.user_id)!==s.approval.adminQq||!s.approval.adminQq)throw new Error('确认通知的主人已变化，未提交。');return;
    }
    if(record.origin==='owner'&&['owner_sticker_collect','owner_sticker_remove'].includes(record.tool))return;
    let target:string|undefined;if(p.group_id!==undefined)target='group:'+Number(p.group_id);else if(p.user_id!==undefined)target='private:'+Number(p.user_id);
    if(['set_friend_add_request','set_group_add_request'].includes(call.action)){const event=this.store.view('events').events.find(event=>event.data.flag===p.flag);if(!event)throw new Error('申请来源已失效，未提交。');target=event.chat;}
    if(target&&!allowedChat(s.social,target,target===record.chat?Number(record.user):undefined))throw new Error('目标已被屏蔽或不在允许名单中，未提交。');
    if(p.group_id!==undefined&&p.user_id!==undefined&&s.social.blockedUsers.includes(String(p.user_id)))throw new Error('目标用户已屏蔽，未提交。');
    if(Array.isArray(p.message))for(const segment of p.message)if(segment?.type==='at'&&s.social.blockedUsers.includes(String(segment.data?.qq)))throw new Error('@ 对象已屏蔽，未提交。');
  }
  async intercept(call:OneBotInvocation,execute:()=>Promise<unknown>):Promise<unknown>{
    if(!protocolMutation(call.action))return execute();const scope=currentOperation();if(!scope)throw new Error('对外动作没有登记执行上下文，未提交。');this.target(scope.record,call);
    return this.executor.remote(call.action,call.params,async()=>{
      await this.verifyAccount(scope.record,scope.signal);
      scope.signal.throwIfAborted();scope.authorize();this.target(scope.record,call);return execute();
    });
  }
  private async verifyAccount(record:OperationRecord,signal:AbortSignal){const actual=await this.options.readAccount(signal);if(actual!==record.account){const failure=Object.assign(new Error('QQ 登录账号已变化，请为新账号选择独立数据目录。'),{code:'ACCOUNT_CHANGED'});this.options.fatal(failure);throw failure;}}
  private async bindAccount(account:number){try{await this.store.account(account);}catch(error){if((error as {code?:string}).code==='ACCOUNT_CHANGED')this.options.fatal(error as Error);throw error;}}
  async effect<T>(name:'qzone_comment',payload:unknown,invoke:()=>Promise<T>):Promise<T>{
    const scope=currentOperation();if(!scope)throw new Error('空间动作没有可信执行上下文');assertProtocolOperation(scope.record,name);
    return this.executor.remote(name,payload,async()=>{await this.verifyAccount(scope.record,scope.signal);scope.signal.throwIfAborted();scope.authorize();return invoke();});
  }
  async notice(target:string,text:string,kind:'approval'|'busy'|'approval-help',signal:AbortSignal,send:()=>Promise<unknown>,source?:{account:number;user:number;time?:number;id?:number}):Promise<unknown>{
    const turn=operationDigest(['notice',source?.account??this.options.account(),target,source?.user??'system',kind,source?.id??randomUUID(),source?.time??0]),record:OperationRecord={id:operationDigest([turn,text]),turn,account:source?.account??this.options.account(),chat:target,user:String(source?.user??'system'),origin:'system',tool:'system_notice',payload:{target,text,kind},summary:kind==='approval'?'发送确认通知':kind==='busy'?'发送忙碌提示':'发送确认回复提示'};
    await this.bindAccount(record.account);
    return this.executor.run(record,signal,()=>{if(this.options.stopping())throw new Error('机器人正在停止');const s=this.options.settings();if(kind==='approval'||kind==='approval-help'){if(target!==`private:${s.approval.adminQq}`||!s.approval.adminQq)throw new Error('主人已变化，未提交确认通知');}else if(!allowedChat(s.social,target,source?.user)||target.startsWith('private:')&&!s.chat.privateAutoReply)throw new Error('会话已关闭或不在允许范围');},async()=>{
      await this.usage.consume(()=>{const s=this.options.settings();return [{key:'social-actions',amount:1,limit:s.social.actionsPerDay,label:'QQ 动作'},{key:'system-notices',amount:1,limit:s.requests.noticesPerDay,label:'确认与忙碌通知'}];});return send();
    });
  }
  async owner<T>(tool:'owner_sticker_collect'|'owner_sticker_remove',payload:unknown,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
    const account=await this.options.readAccount(signal);await this.bindAccount(account);const turn=operationDigest(['owner',account,randomUUID()]),record:OperationRecord={id:operationDigest([turn,tool]),turn,account,chat:`private:${account}`,user:'local-owner',origin:'owner',tool,payload,summary:tool==='owner_sticker_collect'?'手动收藏表情':'手动移除收藏'};
    return this.executor.run(record,signal,()=>{signal.throwIfAborted();if(this.options.stopping())throw new Error('机器人正在停止');},async()=>{await this.usage.consume(()=>[{key:'social-actions',amount:1,limit:this.options.settings().social.actionsPerDay,label:'QQ 动作'}]);return operation();});
  }
  async actions(account:number,chat:string){const page=await this.usage.operationSummaries(account,chat,30);return page.rows.map(({record,state,at,error})=>({id:record.id,chat:record.chat,tool:record.tool,at,state:state==='completed'?'success':['created','reserved','submitting'].includes(state)?'running':state,summary:error||record.summary}));}
  close(){return this.executor.close();}
}
