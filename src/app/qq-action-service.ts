import {z} from 'zod';
import type {BotSettings} from '../core/settings.js';
import type {ToolContext} from '../qq/social-tools.js';
import type {SocialEngine} from '../qq/social-engine.js';
import {legacyTools,LegacyCallSchema} from '../qq/legacy-tools.js';
import {QqActionSchema,type QqAction,type QqActionPolicy} from '../qq/qq-actions.js';
import {assertToolAccess} from '../security/tool-policy.js';
import {allowedChat} from '../qq/social-settings.js';
import {toolEnabled,turnBudget} from '../agent/context-policy.js';
import {withServiceRequestScope} from '../agent/service-request.js';
import type {QqOperationService} from './qq-operation-service.js';

type ActiveContext={active:ToolContext;signal:AbortSignal;sessionId?:string};
type Options={settings:()=>BotSettings;stopping:()=>boolean;context:(conversation?:string)=>ActiveContext|undefined};
const actionNames={send_message:'qq_send_message',like:'qq_like',qzone_post:'qq_qzone_post'} as const;
const legacyReads=new Set(['qq_self_info','qq_get_friend_list','qq_get_group_list','qq_get_group_member_list','qq_get_cookies']);

export class QqActionService {
  constructor(private engine:SocialEngine,private policy:QqActionPolicy,private operations:QqOperationService,private options:Options){}

  execute=async(input:unknown,signal:AbortSignal,conversation?:string,operationId?:string):Promise<unknown>=>{
    if(this.options.stopping())throw new Error('桥接正在退出');
    const source=this.options.context(conversation);if(!source)throw new Error('该会话没有正在执行的模型轮次');
    if(!operationId||!/^[a-f0-9]{64}$/.test(operationId))throw new Error('动作请求缺少可信编号');
    const {active}=source;this.operations.key(active);
    const ctx:ToolContext={...active,sent:0,signal:AbortSignal.any([signal,source.signal]),budget:active.budget??(active.budget=turnBudget())};
    try{
      const action=(input as {action?:string})?.action;
      const social=action==='social'?this.engine.describe(input):undefined;
      const legacy=action==='legacy'?LegacyCallSchema.parse(input):undefined;
      const plain=!social&&!legacy?QqActionSchema.parse(input):undefined;
      const name=social?.call.tool??legacy?.tool??actionNames[plain!.action];
      const definition=legacy?legacyTools.find(tool=>tool.name===legacy.tool):undefined;
      if(legacy&&!definition)throw new Error('未知 QQ 工具');
      const args=social?.args??(legacy?z.object(definition!.schema as z.ZodRawShape).strict().parse(legacy.args):plain);
      const mutates=social?.mutates??(legacy?!legacyReads.has(name):true);
      const authorize=()=>{
        this.engine.check(ctx);assertToolAccess(ctx,this.options.settings(),name,args);this.engine.autonomy.authorize(ctx,plain?.action??name);
        if(social&&!toolEnabled(name,this.options.settings()))throw new Error('该工具已关闭或依赖尚未就绪');ctx.authorize?.();
      };
      const dispatch=async()=>{
        if(social)return withServiceRequestScope({sessionId:source.sessionId,chat:ctx.chat,user:String(ctx.user),background:ctx.origin!=='message',signal:ctx.signal,allowed:()=>{
          ctx.authorize?.();if(ctx.autonomous){this.engine.autonomy.authorize(ctx,'qq_self_state');return true;}return allowedChat(this.options.settings().social,ctx.chat,ctx.user);
        }},()=>this.engine.execute({action:'social',tool:name,args},ctx));
        if(legacy){this.engine.guardTool(ctx,name);return this.engine.legacy(name,args as Record<string,unknown>,ctx);}
        return this.plain(plain!,ctx);
      };
      return await (mutates?this.operations.run(ctx,name,{action,tool:name,args},social?.tool.title??definition?.title??name,authorize,dispatch,operationId):dispatch());
    }finally{
      active.sent+=ctx.sent;active.silent||=ctx.silent;
      if(ctx.topic)active.topic=ctx.topic;if(ctx.endTopic)active.endTopic=true;
    }
  };

  private async plain(action:QqAction,ctx:ToolContext):Promise<unknown>{
    const name=actionNames[action.action];this.engine.guardTool(ctx,name);assertToolAccess(ctx,this.options.settings(),name,action);
    ctx.authorize=()=>assertToolAccess(ctx,this.options.settings(),name,action);
    this.engine.autonomy.authorize(ctx,action.action);this.engine.check(ctx);
    if(action.action==='like')await this.engine.target(ctx,`private:${action.user_id}`,true);
    if(action.action!=='qzone_post')await this.engine.approve(ctx,name,false,action);
    const audit=await this.engine.store.beginAction(ctx.chat,action.action);
    try{
      let result:unknown;
      if(action.action==='send_message')result=await this.engine.send(ctx,[{type:'text',data:{text:action.text}}],`${action.target_type}:${action.target_id}`,true);
      else if(action.action==='qzone_post')result=await this.engine.autonomy.publish(ctx,action.text,action.images??[],(extra,images)=>this.policy.execute({...action,images},ctx.signal,()=>[...this.engine.actionQuotas(ctx),...extra],()=>this.engine.recordAction(ctx.chat)));
      else result=await this.policy.execute(action,ctx.signal,()=>this.engine.actionQuotas(ctx),()=>this.engine.recordAction(ctx.chat));
      await this.engine.store.endAction(audit,'success','已完成');return result;
    }catch(error){await this.engine.store.endAction(audit,'unknown',String(error));throw error;}
  }
}
