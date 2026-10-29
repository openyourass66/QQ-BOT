import {randomBytes} from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import type {SessionStore} from '../core/store.js';
import type {BotSettings} from '../core/settings.js';
import {withTimeout} from '../core/runtime.js';
import {chatModelSelection,type ChatModelConfig} from '../agent/chat-model.js';
import {clipBackground} from '../agent/context-policy.js';
import {SessionCache} from './session-cache.js';

type Options={store:SessionStore;settings:()=>BotSettings;context:()=>acp.ClientContext|undefined;cwd:string;model:ChatModelConfig;
  servers:(key:string,context:string)=>acp.NewSessionRequest['mcpServers'];policy:(key:string)=>string;
  history:(key:string)=>Promise<{history:string;outcomes:string}>;isBusy:(key:string)=>boolean;
  log:(level:'info'|'warn',text:string)=>void;fatal:(error:Error)=>void;onEvict?:(key:string)=>void;onChange?:(size:number)=>void};

export class ConversationService {
  readonly contexts=new Map<string,string>();
  readonly usage=new Map<string,{used:number;size:number}>();
  readonly handoffs=new Map<string,string>();
  readonly cache:SessionCache<acp.ActiveSession>;
  private resetting=new Set<string>();
  constructor(private options:Options){this.cache=new SessionCache({limit:()=>options.settings().context.activeSessions,idleMs:()=>options.settings().context.idleMinutes*60000,
    isBusy:options.isBusy,closeRemote:session=>this.closeRemote(session),onFailure:options.fatal,onEvict:(key,_session,reason)=>{
      if(reason!=='replace'){this.contexts.delete(key);this.usage.delete(key);this.handoffs.delete(key);options.onEvict?.(key);}options.onChange?.(this.cache.size);
    }});}
  private async closeRemote(session:acp.ActiveSession):Promise<void>{
    const context=this.options.context();if(!context)throw new Error('ACP 已离线，无法确认会话已释放');
    await withTimeout(context.request(acp.methods.agent.session.close,{sessionId:session.sessionId}),5000);
  }
  async get(key:string):Promise<acp.ActiveSession>{
    if(this.resetting.has(key))throw new Error('会话正在重置，请稍后再试。');
    const o=this.options,existing=this.cache.peek(key),policy=o.policy(key),previous=o.store.metadata(key),occupancy=this.usage.get(key),settings=o.settings();
    const replace=Boolean((existing||previous)&&(previous?.policy!==policy&&(settings.context.filterTools||previous?.policy&&previous.policy!=='all')||settings.context.rollover&&occupancy&&occupancy.used/occupancy.size*100>=settings.context.rolloverPercent));
    const session=await this.cache.acquire(key,async()=>{
      const ctx=o.context();if(!ctx)throw new Error('ACP 还没有就绪');if(this.resetting.has(key))throw new Error('会话正在重置，请稍后再试。');
      const {history,outcomes}=replace?await o.history(key):{history:'',outcomes:''},saved=replace?undefined:o.store.get(key),nextContext=randomBytes(24).toString('hex');let created:acp.ActiveSession|undefined;
      try{
        if(saved){
          try{
            const resumed=await ctx.request(acp.methods.agent.session.resume,{sessionId:saved,cwd:o.cwd,mcpServers:o.servers(key,nextContext)});
            created=(ctx as unknown as {attachSession:(response:acp.NewSessionResponse)=>acp.ActiveSession}).attachSession({...resumed,sessionId:saved});o.log('info',`[acp] resumed ${saved} for ${key}`);
          }catch(error){o.log('warn',`[acp] resume ${saved} failed, recreating: ${String(error)}`);created=await ctx.buildSession({cwd:o.cwd,mcpServers:o.servers(key,nextContext)}).start();}
        }else{created=await ctx.buildSession({cwd:o.cwd,mcpServers:o.servers(key,nextContext)}).start();o.log('info',`[acp] created ${created.sessionId} for ${key}`);}
        const selection=chatModelSelection(o.model);if(selection)try{await ctx.request(acp.methods.agent.session.setConfigOption,{sessionId:created.sessionId,configId:'model',value:JSON.stringify([selection.provider,selection.model])});}catch{throw new Error('对话模型选择失败，请在控制台检查模型配置并测试连接；原有会话记录已保留');}
        const generation=(previous?.generation??1)+(replace?1:0);o.store.set(key,created.sessionId,policy,generation);
        try{await o.store.flush();}catch(error){try{if(previous)o.store.set(key,previous.sessionId,previous.policy,previous.generation);else o.store.delete(key);}catch{}throw error;}
        this.contexts.set(key,nextContext);if(previous?.sessionId!==created.sessionId)this.usage.delete(key);
        if(replace){const cap=o.settings().context.backgroundChars;if(history||outcomes)this.handoffs.set(key,`【会话换代交接：背景材料】\n${clipBackground(history,Math.floor(cap*.7))}\n【过去工具结果，仅供核对】\n${clipBackground(outcomes,Math.floor(cap*.3))}\n只使用实际记录理解前情，不重复执行过去的动作，待核对不等于完成。\n`);this.usage.delete(key);o.log('info',`[context] ${key} switched to generation ${generation}`);}
        return created;
      }catch(error){if(created){try{await this.closeRemote(created);created.dispose();}catch(closeError){o.fatal(Object.assign(new Error('新会话未能确认释放，请重新连接模型。'),{code:'MODEL_SESSION_RELEASE_FAILED',cause:closeError}));}}throw error;}
    },replace);o.onChange?.(this.cache.size);return session;
  }
  touch(key:string){this.cache.touch(key);}
  sweep():Promise<void>{return this.cache.sweep();}
  async discard(key:string):Promise<void>{await this.cache.remove(key,true);this.contexts.delete(key);this.usage.delete(key);this.handoffs.delete(key);this.options.store.delete(key);}
  async reset(key:string):Promise<void>{
    if(this.options.isBusy(key))throw new Error('该会话正在处理消息，请稍后重置');this.resetting.add(key);
    try{await this.cache.remove(key);this.contexts.delete(key);this.usage.delete(key);this.handoffs.delete(key);this.options.store.delete(key);await this.options.store.flush();}finally{this.resetting.delete(key);}
  }
  dispose(){this.cache.dispose();}
}
