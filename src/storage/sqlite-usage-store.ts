import {readFile,writeFile,mkdir,lstat,statfs,link,unlink,rm,open} from 'node:fs/promises';
import {dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DailyUsageStore,UsageSchema,shanghaiDate,type Quota} from '../core/usage.js';
import {DatabaseClient} from './database-client.js';
import {verifyMigrationSource} from './social-migration.js';
import type {ModelRequestRecord,ReportedUsage} from './database-types.js';
import type {OperationRecord,StoredOperation} from './operation-types.js';
import {operationDigest,currentOperation} from '../core/operation-context.js';
import type {MediaCacheStore} from './media-cache-types.js';

export const usageDatabasePath=(path:string)=>path+'.sqlite';
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(counters:Record<string,number>)=>JSON.stringify(Object.fromEntries(Object.entries(counters).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)))));
const failure=(message:string)=>Object.assign(new Error(message),{code:'DATABASE_INVALID'});
async function ensureDatabase(path:string,date:string):Promise<string>{
  const target=usageDatabasePath(path),existing=await lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(existing){if(!existing.isFile()||existing.nlink>1)throw failure('额度数据库路径不支持链接或非普通文件。');return target;}
  await mkdir(dirname(path),{recursive:true});const info=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(info&&(!info.isFile()||info.nlink>1||info.size>16*1024*1024))throw failure('旧额度文件类型或大小超出支持范围，原文件保留。');
  const raw=info?await readFile(path):undefined;let data;
  try{data=raw?UsageSchema.parse(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''))):{version:1 as const,date,counters:{}};}catch{throw failure('旧额度文件格式无效，原文件保留，请先核对。');}
  const sha256=raw?hash(raw):null,normalized=hash(data.date+'\n'+canonical(data.counters)),space=await statfs(dirname(path));
  if(space.bavail*space.bsize<Math.max((raw?.length??0)*3,32*1024*1024))throw Object.assign(new Error('磁盘空间不足，额度原文件保留。'),{code:'ENOSPC'});
  if(raw){const backup=path+'.pre-sqlite-'+sha256!.slice(0,16)+'.bak';try{await writeFile(backup,raw,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}if(hash(await readFile(backup))!==sha256)throw failure('额度备份与原文件不一致，原文件保留。');}
  const staging=target+'.migration-'+randomUUID(),client=new DatabaseClient(staging);let activated=false;
  try{
    await client.call({action:'complete-import',source:{kind:'daily-usage',sha256,file:basename(path),normalizedSha256:normalized,migratedAt:new Date().toISOString()}});
    const rows=Object.entries(data.counters);for(let index=0;index<rows.length;index+=256)await client.call({action:'usage-import',date:data.date,counters:Object.fromEntries(rows.slice(index,index+256)),final:false});
    await client.call({action:'usage-import',date:data.date,counters:{},final:true});
    const actual=await client.call<{date:string;counters:Record<string,number>}>({action:'usage-summary',date:data.date});if(hash(actual.date+'\n'+canonical(actual.counters))!==normalized||(await client.call<{check:string[]}>({action:'integrity'})).check.join(',')!=='ok')throw failure('额度迁移校验未通过，原文件保留。');
    await client.close();const current=await readFile(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(raw?(!current||hash(current)!==sha256):!!current)throw failure('额度迁移期间原文件发生变化，已取消切换。');const handle=await open(staging,'r+');try{await handle.sync();}finally{await handle.close();}await link(staging,target);await unlink(staging);activated=true;return target;
  }finally{await client.close().catch(()=>{});if(!activated)for(const suffix of ['','-wal','-shm'])await rm(staging+suffix,{force:true}).catch(()=>{});}
}

export class SqliteDailyUsageStore extends DailyUsageStore {
  readonly instanceId=randomUUID();
  readonly mediaCacheStore:MediaCacheStore={call:request=>{if(!this.loaded||this.closing)return Promise.reject(new Error('额度仓储未打开或已经关闭'));return this.database!.call(request);}};
  private database?:DatabaseClient;
  private chain:Promise<unknown>=Promise.resolve();
  private queued=0;
  private loaded=false;
  private closing=false;
  private closeTask?:Promise<void>;
  onFailure?:(error:Error)=>void;
  override async load():Promise<void>{
    if(this.loaded||this.closing)throw new Error('额度仓储已经打开或已关闭。');
    const database=new DatabaseClient(await ensureDatabase(this.path,shanghaiDate(this.now())));this.database=database;database.onFailure=error=>this.onFailure?.(error);
    try{
      const metadata=await database.call<{initialized:boolean;usageInitialized:boolean;source:{sha256?:string;kind?:string}}>({action:'metadata'});
      if(!metadata.initialized||!metadata.usageInitialized||metadata.source?.kind!=='daily-usage')throw failure('额度数据库类型或迁移状态无效，请保留文件并核对。');
      await verifyMigrationSource(this.path,metadata.source);await database.call({action:'usage-recover-models'});await database.call({action:'usage-op-recover'});await database.call({action:'media-cache-recover'});const current=await database.call<{date:string;counters:Record<string,number>}>({action:'usage-summary',date:shanghaiDate(this.now())});this.data={version:1,...current};this.loaded=true;
    }catch(error){await database.close();throw error;}
  }
  override consume(getQuotas:()=>Quota[],onReserved:()=>void=()=>{}):Promise<void>{
    const operation=currentOperation();if(operation){
      if(operation.owner!==this.instanceId)return Promise.reject(Object.assign(new Error('动作额度不属于当前仓储实例。'),{code:'DATABASE_OPERATION_CONFLICT'}));
      const index=operation.quotaSequence++;return this.reserveOperation(operation.record.id,index,()=>{operation.signal.throwIfAborted();operation.authorize();return getQuotas();},onReserved).then(result=>{if(result.reused)throw Object.assign(new Error('动作额度已经预扣，不会再次提交。'),{code:'DATABASE_OPERATION_CONFLICT'});});
    }
    return this.reserve(getQuotas,onReserved,randomUUID()).then(()=>{});
  }
  reserveModel(request:ModelRequestRecord,getQuotas:()=>Quota[]):Promise<{reused:boolean}>{return this.reserve(getQuotas,()=>{},request.id,request);}
  finishModel(id:string,outcome:'completed'|'failed'|'unknown',usage:ReportedUsage):Promise<unknown>{return this.database!.call({action:'usage-finish-model',id,outcome,usage});}
  requestStatistics():Promise<unknown>{return this.database!.call({action:'usage-request-stats',date:shanghaiDate(this.now())});}
  beginOperation(record:OperationRecord):Promise<{claimed:boolean;operation:StoredOperation}>{const {id:_,turn:__,summary:___,...semantic}=record;return this.database!.call({action:'usage-op-begin',record,owner:this.instanceId,date:shanghaiDate(this.now()),at:this.now().getTime(),hash:operationDigest(record),semanticHash:operationDigest(semantic)});}
  reserveOperation(id:string,index:number,getQuotas:()=>Quota[],onReserved:()=>void=()=>{}):Promise<{reused:boolean}>{return this.reserve(getQuotas,onReserved,operationDigest([id,'quota',index]),undefined,{id,owner:this.instanceId});}
  submitOperation(id:string,sequence:number,name:string,payload:unknown):Promise<{claimed:boolean;state?:string;result?:unknown}>{return this.database!.call({action:'usage-op-submit',id,owner:this.instanceId,sequence,name,payload,hash:operationDigest({name,payload}),at:this.now().getTime()});}
  finishOperationStep(id:string,sequence:number,state:'completed'|'unknown',result?:unknown,error?:string):Promise<unknown>{return this.database!.call({action:'usage-op-step',id,owner:this.instanceId,sequence,state,...(result===undefined?{}:{result}),...(error===undefined?{}:{error})});}
  completeOperation(id:string,result:unknown):Promise<unknown>{return this.database!.call({action:'usage-op-complete',id,owner:this.instanceId,result});}
  failOperation(id:string,error:string):Promise<{state:string}>{return this.database!.call({action:'usage-op-fail',id,owner:this.instanceId,error});}
  operation(id:string):Promise<StoredOperation|null>{return this.database!.call({action:'usage-op-read',id});}
  operationSummaries(account:number,chat?:string,limit=100,offset=0):Promise<{rows:Array<{record:Omit<OperationRecord,'payload'>;state:string;at:number;error:string}>;total:number}>{return this.database!.call({action:'usage-op-list',account,...(chat===undefined?{}:{chat}),limit,offset});}
  private reserve(getQuotas:()=>Quota[],onReserved:()=>void,reservationId:string,request?:ModelRequestRecord,operation?:{id:string;owner:string}):Promise<{reused:boolean}>{
    if(!this.loaded||this.closing)return Promise.reject(new Error('额度仓储未打开或已经关闭。'));
    if(this.queued>=64)return Promise.reject(Object.assign(new Error('额度操作正在处理，请稍后重试。'),{code:'DATABASE_QUEUE_FULL'}));
    this.queued++;const task=this.chain.then(async()=>{
      const now=this.now(),date=shanghaiDate(now),quotas=getQuotas();
      try{const current=await this.database!.call<{date:string;counters:Record<string,number>;reused:boolean}>({action:'usage-consume',date,quotas,reservationId,at:now.getTime(),...(request?{request}:{}),...(operation?{operation}:{})});this.data={version:1,date:current.date,counters:current.counters};if(!current.reused)onReserved();return {reused:current.reused};}
      catch(error){if((error as {code?:string}).code==='DATABASE_QUOTA_EXCEEDED'){const current=await this.database!.call<{date:string;counters:Record<string,number>}>({action:'usage-summary',date});this.data={version:1,...current};}throw error;}
    });this.chain=task.catch(()=>{});return task.finally(()=>{this.queued--;});
  }
  override async flush():Promise<void>{await this.chain;}
  close():Promise<void>{return this.closeTask??=(async()=>{this.closing=true;await this.chain;await this.database?.close();})();}
}
