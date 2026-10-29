import {Worker} from 'node:worker_threads';
import {DATABASE_LIMITS,type DatabaseRequest} from './database-types.js';

const databaseError=(code:string,message:string)=>Object.assign(new Error(message),{code});
type Pending={bytes:number;action:string;timer:NodeJS.Timeout;resolve:(value:any)=>void;reject:(error:Error)=>void};
export class DatabaseClient {
  private worker?:Worker;
  private opening?:Promise<void>;
  private failure?:Error;
  private pending=new Map<number,Pending>();
  private sequence=0;
  private bytes=0;
  private closing=false;
  private closeTask?:Promise<void>;
  onFailure?:(error:Error)=>void;
  onMeasurement?:(action:string,elapsedMs:number)=>void;
  constructor(readonly path:string,private options:{maxPending?:number;maxPendingBytes?:number;timeoutMs?:number;workerUrl?:URL}={}){}
  get pendingCount(){return this.pending.size;}
  get pendingBytes(){return this.bytes;}
  open():Promise<void>{
    return this.opening??=(async()=>{
      if(this.closing)throw databaseError('DATABASE_CLOSED','数据库已经关闭。');
      const worker=new Worker(this.options.workerUrl??new URL('./database-worker.js',import.meta.url),{workerData:{path:this.path},execArgv:[]});this.worker=worker;
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{const error=databaseError('DATABASE_WORKER_TIMEOUT','数据库工作线程启动超时。');reject(error);this.fail(error);},this.options.timeoutMs??DATABASE_LIMITS.timeoutMs);
        const failed=(error:Error)=>{clearTimeout(timer);reject(error);this.fail(error);};
        worker.on('error',()=>failed(databaseError('DATABASE_WORKER_EXITED','数据库工作线程异常退出，请重新启动。')));
        worker.on('exit',()=>{if(!this.closing)failed(databaseError('DATABASE_WORKER_EXITED','数据库工作线程已经退出，请重新启动。'));});
        worker.on('message',message=>{
          if(message.type==='ready'){clearTimeout(timer);worker.unref();resolve();return;}
          if(message.type==='failed'){failed(databaseError(message.error.code,message.error.message));return;}
          const item=this.pending.get(message.id);if(!item)return;this.pending.delete(message.id);this.bytes-=item.bytes;clearTimeout(item.timer);if(!this.pending.size)worker.unref();
          if(message.ok){try{this.onMeasurement?.(item.action,message.elapsedMs);}catch{}item.resolve(message.result);}else{const error=databaseError(message.error.code,message.error.message);item.reject(error);if(['DATABASE_REVISION_CONFLICT','DATABASE_OPERATION_FAILED','DATABASE_INVALID','DATABASE_NOT_INITIALIZED'].includes(message.error.code))this.fail(error);}
        });
      });
    })();
  }
  private fail(error:Error){
    if(this.failure)return;this.failure=error;
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();this.bytes=0;void this.worker?.terminate();try{this.onFailure?.(error);}catch{}
  }
  async call<T=any>(request:DatabaseRequest):Promise<T>{
    if(this.failure)throw this.failure;if(this.closing&&request.action!=='close')throw databaseError('DATABASE_CLOSED','数据库已经关闭。');
    await this.open();if(this.failure)throw this.failure;if(this.closing&&request.action!=='close')throw databaseError('DATABASE_CLOSED','数据库已经关闭。');
    const bytes=Buffer.byteLength(JSON.stringify(request));if(bytes>DATABASE_LIMITS.requestBytes)throw databaseError('DATABASE_REQUEST_TOO_LARGE','数据库请求过大，请分批处理。');
    if(this.pending.size>=(this.options.maxPending??DATABASE_LIMITS.pending)||this.bytes+bytes>(this.options.maxPendingBytes??DATABASE_LIMITS.pendingBytes))throw databaseError('DATABASE_QUEUE_FULL','数据写入正在处理，请稍后重试。');
    return new Promise<T>((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>this.fail(databaseError('DATABASE_WORKER_TIMEOUT','数据库操作超时，结果需要核对；本次操作不会自动重试。')),this.options.timeoutMs??DATABASE_LIMITS.timeoutMs);
      this.pending.set(id,{bytes,action:request.action,timer,resolve,reject});this.bytes+=bytes;this.worker!.ref();
      try{this.worker!.postMessage({id,request});}catch{this.fail(databaseError('DATABASE_WORKER_EXITED','数据库工作线程不可用，请重新启动。'));}
    });
  }
  close():Promise<void>{
    return this.closeTask??=(async()=>{
      if(this.closing)return;this.closing=true;if(!this.worker)return;
      try{if(!this.failure)await this.call({action:'close'});}finally{await this.worker.terminate();}
    })();
  }
}
