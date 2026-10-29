import {randomBytes} from 'node:crypto';

export class JobError extends Error {constructor(message,statusCode=409){super(message);this.statusCode=statusCode;}}
const done=job=>['succeeded','failed','cancelled'].includes(job.state);
const publicJob=({id,kind,component,state,phase,createdAt,updatedAt,message,version})=>({id,kind,...(component?{component}:{}),state,phase,createdAt,updatedAt,message,version});

/** 只保留受限任务状态；请求正文、凭据及底层错误不进入任务记录。 */
export class ManagementJobs {
  constructor({execute,cancel,validate,publish,clock=Date.now}){Object.assign(this,{execute,cancel,validate,publish,clock});this.records=[];this.tail=Promise.resolve();this.closed=false;}
  list(scope){return this.records.filter(job=>job.scope===scope).map(publicJob).reverse();}
  get busy(){return this.records.some(job=>!done(job));}
  get(id,scope){const job=this.records.find(job=>job.id===id&&job.scope===scope);if(!job)throw new JobError('任务不存在或已过期',404);return publicJob(job);}
  #changed(job){job.updatedAt=this.clock();job.version++;this.publish(publicJob(job));}
  submit({kind,component,key,scope,credential}){
    if(this.closed)throw new JobError('管理服务正在关闭',503);
    if(!/^[A-Za-z0-9_-]{16,64}$/.test(key||''))throw new JobError('请提供有效的操作编号',400);
    const repeated=this.records.find(job=>job.key===key&&job.scope===scope);
    if(repeated){if(repeated.kind!==kind||repeated.component!==component)throw new JobError('操作编号已用于其它任务');return publicJob(repeated);}
    const pending=this.records.filter(job=>!done(job));
    if(pending.length){
      if(kind!=='stop'||pending.length!==1||pending[0].kind!=='component')throw new JobError('已有管理任务正在进行，请等待完成或取消');
      this.cancelJob(pending[0].id,pending[0].scope);
    }
    const now=this.clock();this.records=this.records.filter(job=>!done(job)||now-job.updatedAt<86400000);
    while(this.records.length>=64){const index=this.records.findIndex(done);if(index<0)throw new JobError('任务记录已达上限',429);this.records.splice(index,1);}
    const job={id:randomBytes(16).toString('hex'),kind,component,key,scope,state:'queued',phase:'queued',createdAt:now,updatedAt:now,message:'等待执行',cancelled:false,version:0};
    this.records.push(job);this.#changed(job);
    const task=this.tail.then(async()=>{
      try{
        if(job.cancelled)throw new JobError('已取消');
        await this.validate(credential,scope);
        if(job.cancelled)throw new JobError('已取消');
        job.state='running';job.phase='running';job.message='正在执行';this.#changed(job);
        await this.execute(kind,component);
        job.state=job.cancelled?'cancelled':'succeeded';job.phase=job.state;job.message=job.cancelled?'已取消':'操作已完成，请核对运行状态';
      }catch{job.state=job.cancelled?'cancelled':'failed';job.phase=job.state;job.message=job.cancelled?'已取消':'操作未完成，请核对配置或在本机查看诊断后重试';}
      finally{this.#changed(job);}
    });
    this.tail=task.catch(()=>{});return publicJob(job);
  }
  cancelJob(id,scope){
    const job=this.records.find(item=>item.id===id&&item.scope===scope);
    if(!job)throw new JobError('任务不存在或已过期',404);
    if(done(job))return publicJob(job);
    if(job.kind!=='component'&&job.state==='running')throw new JobError('该操作已开始，请等待结果');
    job.cancelled=true;job.message='正在取消';this.#changed(job);
    if(job.kind==='component'&&job.state==='running')Promise.resolve(this.cancel()).catch(()=>{});
    return publicJob(job);
  }
  progress(event){const job=this.records.find(job=>job.kind==='component'&&job.state==='running');if(job&&['downloading','copying','extracting','installing','checking','ready'].includes(event.phase)){job.phase=event.phase;this.#changed(job);}}
  async close(){this.closed=true;for(const job of this.records.filter(job=>!done(job)&&(job.kind==='component'||job.state==='queued')))this.cancelJob(job.id,job.scope);await this.tail;}
}
