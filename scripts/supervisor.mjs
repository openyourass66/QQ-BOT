import {classifyRuntimeFailure} from '../dist/core/runtime-failure.js';

export class ProcessSupervisor {
  constructor({recover,onChange=()=>{},now=Date.now,random=Math.random,schedule=setTimeout,cancel=clearTimeout,maxRestarts=5,windowMs=600000,stableMs=60000}){
    Object.assign(this,{recover,onChange,now,random,schedule,cancel,maxRestarts,windowMs,stableMs});this.entries=new Map();this.closed=false;
  }
  entry(name){if(!this.entries.has(name))this.entries.set(name,{phase:'stopped',attempts:[],retryAt:0,readySince:0,failure:undefined,timer:undefined});return this.entries.get(name);}
  changed(){this.onChange(this.snapshot());}
  snapshot(){return Object.fromEntries([...this.entries].map(([name,item])=>[name,{phase:item.phase,restarts:item.attempts.length,retryAt:item.retryAt,...(item.failure?{failure:item.failure}:{})}]));}
  starting(name,{manual=false,waitingLogin=false}={}){
    const item=this.entry(name);if(item.timer)this.cancel(item.timer);item.timer=undefined;item.retryAt=0;item.phase=waitingLogin?'waiting_login':'connecting';item.readySince=0;item.failure=undefined;if(manual)item.attempts=[];this.changed();
  }
  status(name,{ready=false,waitingLogin=false}={}){
    const item=this.entry(name);if(this.closed||item.phase==='stopped'||item.phase==='recovering'||item.phase==='needs_attention')return;
    const phase=ready?'ready':waitingLogin?'waiting_login':'connecting';if(phase==='ready'&&item.phase!=='ready')item.readySince=this.now();if(phase!=='ready')item.readySince=0;
    if(item.phase!==phase){item.phase=phase;this.changed();}
  }
  attention(name,failure){const item=this.entry(name);if(item.timer)this.cancel(item.timer);item.timer=undefined;item.retryAt=0;item.phase='needs_attention';item.failure=failure;this.changed();}
  stopped(name){const item=this.entry(name);if(item.timer)this.cancel(item.timer);item.timer=undefined;item.retryAt=0;item.phase='stopped';item.readySince=0;this.changed();}
  exited(name,failure=classifyRuntimeFailure(undefined)){
    const item=this.entry(name);if(this.closed||item.phase==='stopped')return;
    if(!failure.recoverable){this.attention(name,failure);return;}
    const now=this.now();if(item.phase==='ready'&&now-item.readySince>=this.stableMs)item.attempts=[];
    item.attempts=item.attempts.filter(time=>now-time<this.windowMs);item.failure=failure;item.readySince=0;
    if(item.attempts.length>=this.maxRestarts){this.attention(name,{code:'RESTART_LIMIT',recoverable:false,message:'短时间内连续恢复失败，已停止重试；请处理诊断问题后手动启动。'});return;}
    const delay=Math.round(Math.min(1000*2**item.attempts.length,16000)*(.8+.4*this.random()));
    item.attempts.push(now);item.phase='recovering';item.retryAt=now+delay;
    if(item.timer)this.cancel(item.timer);
    item.timer=this.schedule(()=>{
      item.timer=undefined;if(this.closed||item.phase!=='recovering')return;
      item.retryAt=0;item.phase='connecting';this.changed();
      Promise.resolve().then(()=>this.recover(name)).catch(error=>this.exited(name,classifyRuntimeFailure(error)));
    },delay);this.changed();
  }
  close(){this.closed=true;for(const name of this.entries.keys())this.stopped(name);}
}
