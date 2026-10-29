import {performance} from 'node:perf_hooks';

type Session={sessionId:string;dispose:()=>void};
type Reason='capacity'|'idle'|'replace'|'reset'|'shutdown';
type Options<S>={limit:()=>number;idleMs:()=>number;isBusy:(key:string)=>boolean;closeRemote:(session:S)=>Promise<void>;onEvict?:(key:string,session:S,reason:Reason)=>void;onFailure?:(error:Error)=>void;now?:()=>number};
const full=()=>Object.assign(new Error('活跃模型会话已满，请等待当前聊天结束后重试。'),{code:'SESSION_CACHE_FULL'});

/** A slot is released only after the remote process acknowledges session/close. */
export class SessionCache<S extends Session> {
  private items=new Map<string,{session:S;touched:number}>();
  private opening=new Map<string,Promise<S>>();
  private reserved=new Set<string>();
  private releasing=new Set<string>();
  private admission:Promise<unknown>=Promise.resolve();
  private closed=false;
  private failure?:Error;
  constructor(private options:Options<S>){}
  get size(){return this.items.size;}
  peek(key:string):S|undefined{return this.releasing.has(key)?undefined:this.items.get(key)?.session;}
  values():S[]{return [...this.items.values()].map(item=>item.session);}
  private now(){return(this.options.now??(()=>performance.now()))();}
  private check(){if(this.failure)throw this.failure;if(this.closed)throw new Error('模型会话管理已停止');}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const task=this.admission.then(operation);this.admission=task.catch(()=>{});return task;}
  private fail(error:unknown):Error{if(!this.failure){this.failure=Object.assign(new Error('模型会话未确认释放，已停止继续创建，请重新连接模型。'),{code:'MODEL_SESSION_RELEASE_FAILED',cause:error});this.options.onFailure?.(this.failure);}return this.failure;}
  private candidate(except?:string){return [...this.items].filter(([key])=>key!==except&&!this.options.isBusy(key)&&!this.opening.has(key)).sort((a,b)=>a[1].touched-b[1].touched)[0];}
  private async release(key:string,item:{session:S;touched:number},reason:Reason){
    this.releasing.add(key);
    try{try{await this.options.closeRemote(item.session);}catch(error){throw this.fail(error);}
      if(this.closed)return;item.session.dispose();if(this.items.get(key)===item)this.items.delete(key);this.options.onEvict?.(key,item.session,reason);
    }finally{this.releasing.delete(key);}
  }
  touch(key:string){const item=this.items.get(key);if(item)item.touched=this.now();}
  acquire(key:string,create:(previous:S|undefined)=>Promise<S>,replace=false):Promise<S>{
    try{this.check();}catch(error){return Promise.reject(error);}const inflight=this.opening.get(key);if(inflight)return inflight;
    if(this.releasing.has(key))return this.serial(async()=>{}).then(()=>this.acquire(key,create,replace));
    const existing=this.items.get(key);if(existing&&!replace){this.touch(key);return Promise.resolve(existing.session);}
    const task=(async()=>{
      await this.serial(async()=>{
        this.check();
        while(this.items.size+this.reserved.size>=this.options.limit()){
          const victim=this.candidate(key),previous=replace?this.items.get(key):undefined;
          if(victim)await this.release(...victim,'capacity');else if(previous)await this.release(key,previous,'replace');else throw full();
        }this.reserved.add(key);
      });
      let next:S|undefined;
      try{
        this.check();
        next=await create(this.items.get(key)?.session);
        return await this.serial(async()=>{
          if(this.closed){next!.dispose();throw new Error('模型会话管理已停止');}this.check();
          const previous=this.items.get(key);if(previous&&previous.session!==next)await this.release(key,previous,'replace');
          this.reserved.delete(key);this.items.set(key,{session:next!,touched:this.now()});return next!;
        });
      }catch(error){if(next&&this.items.get(key)?.session!==next&&!this.closed){try{await this.options.closeRemote(next);next.dispose();}catch(closeError){this.fail(closeError);}}throw error;}
      finally{this.reserved.delete(key);}
    })().finally(()=>{this.opening.delete(key);});this.opening.set(key,task);return task;
  }
  sweep():Promise<void>{return this.serial(async()=>{
    this.check();const victim=this.candidate();if(victim&&(this.items.size>this.options.limit()||this.now()-victim[1].touched>=this.options.idleMs()))await this.release(...victim,this.items.size>this.options.limit()?'capacity':'idle');
  });}
  remove(key:string,allowBusy=false):Promise<void>{return this.serial(async()=>{
    this.check();if(!allowBusy&&(this.options.isBusy(key)||this.opening.has(key)))throw new Error('当前会话正在处理，请等本轮结束后重置。');const item=this.items.get(key);if(item)await this.release(key,item,'reset');
  });}
  dispose(){this.closed=true;for(const [key,item] of this.items){item.session.dispose();this.options.onEvict?.(key,item.session,'shutdown');}this.items.clear();}
}
