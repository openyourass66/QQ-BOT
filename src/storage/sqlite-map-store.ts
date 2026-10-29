import {readFile,writeFile,mkdir,lstat,statfs,link,unlink,rm,open} from 'node:fs/promises';
import {dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseClient} from './database-client.js';
import {verifyMigrationSource} from './social-migration.js';
import type {EntityRow,EntityChange} from './database-types.js';

type Codec={kind:'sessions'|'group-context';maxEntries:number;decode:(value:unknown)=>Record<string,unknown>;wrap:(entries:Record<string,unknown>)=>unknown;validateEntries?:(entries:Record<string,unknown>)=>Record<string,unknown>};
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const invalid=(message:string)=>Object.assign(new Error(message),{code:'DATABASE_INVALID'});
function rowsFor(entries:Record<string,unknown>):EntityRow[]{return Object.entries(entries).map(([key,value],ordinal)=>({table:'state',key,ordinal,value}));}
function fingerprint(rows:EntityRow[]){const digest=createHash('sha256');for(const row of [...rows].sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key))))digest.update(JSON.stringify(row)+'\n');return digest.digest('hex');}
function validate(codec:Codec,raw:unknown):Record<string,unknown>{
  let entries;try{entries=codec.decode(raw);}catch(error){if((error as {code?:string}).code==='DATABASE_STATE_LIMIT')throw error;throw invalid('会话或上下文文件格式无效，原文件保留，请先核对。');}
  if(Object.keys(entries).length>codec.maxEntries)throw invalid('会话或上下文记录超过支持容量，原文件保留，请先整理。');
  for(const [key,value] of Object.entries(entries))if(key.length>1024||Buffer.byteLength(JSON.stringify(value))>1024*1024)throw invalid('单条会话或上下文记录超过支持容量，原文件保留。');return entries;
}
async function ensureDatabase(path:string,codec:Codec){
  const target=path+'.sqlite',existing=await lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(existing){if(!existing.isFile()||existing.nlink>1)throw invalid('会话数据库路径不支持链接或非普通文件。');return target;}
  await mkdir(dirname(path),{recursive:true});const info=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(info&&(!info.isFile()||info.nlink>1||info.size>32*1024*1024))throw invalid('旧会话文件类型或大小超出支持范围，原文件保留。');
  const raw=info?await readFile(path):undefined;let parsed:unknown;try{parsed=raw?JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,'')):codec.wrap({});}catch{throw invalid('旧会话或上下文文件损坏，原文件保留。');}
  const entries=validate(codec,parsed),rows=rowsFor(entries),sha256=raw?hash(raw):null,normalized=fingerprint(rows),space=await statfs(dirname(path));
  if(space.bavail*space.bsize<Math.max((raw?.length??0)*3,32*1024*1024))throw Object.assign(new Error('磁盘空间不足，会话或上下文原文件保留。'),{code:'ENOSPC'});
  if(raw){const backup=path+'.pre-sqlite-'+sha256!.slice(0,16)+'.bak';try{await writeFile(backup,raw,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}if(hash(await readFile(backup))!==sha256)throw invalid('会话或上下文备份与原文件不一致，原文件保留。');}
  const staging=target+'.migration-'+randomUUID(),client=new DatabaseClient(staging);let activated=false;
  try{
    let batch:EntityRow[]=[],bytes=0;const flush=async()=>{if(batch.length)await client.call({action:'import',rows:batch});batch=[];bytes=0;};
    for(const row of rows){const size=Buffer.byteLength(JSON.stringify(row));if(batch.length>=256||bytes+size>1024*1024)await flush();batch.push(row);bytes+=size;}await flush();
    const actual=await client.call<{sha256:string}>({action:'fingerprint'}),check=await client.call<{check:string[]}>({action:'integrity'});
    if(actual.sha256!==normalized||check.check.join(',')!=='ok')throw invalid('会话或上下文迁移校验未通过，原文件与备份保留。');
    await client.call({action:'complete-import',source:{kind:codec.kind,file:basename(path),sha256,normalizedSha256:normalized,migratedAt:new Date().toISOString()}});await client.close();
    const current=await readFile(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(raw?(!current||hash(current)!==sha256):!!current)throw invalid('迁移期间原会话文件发生变化，已取消切换。');
    const handle=await open(staging,'r+');try{await handle.sync();}finally{await handle.close();}await link(staging,target);await unlink(staging);activated=true;return target;
  }finally{await client.close().catch(()=>{});if(!activated)for(const suffix of ['','-wal','-shm'])await rm(staging+suffix,{force:true}).catch(()=>{});}
}

/** Small bounded runtime caches; persistence changes only the keys they touch. */
export class SqliteMapStore {
  private database?:DatabaseClient;
  private revision=0;
  private ordinal=0;
  private batches:Array<{changes:Map<string,{change:EntityChange;bytes:number}>;bytes:number}>=[];
  private pendingBytes=0;
  private saving?:Promise<void>;
  private failure?:Error;
  private loaded=false;
  private closing=false;
  private closeTask?:Promise<void>;
  onFailure?:(error:Error)=>void;
  constructor(private path:string,private codec:Codec){}
  private fail(error:unknown){if(!this.failure){this.failure=error instanceof Error?error:new Error('会话数据库写入失败');this.onFailure?.(this.failure);}return this.failure;}
  async load():Promise<Record<string,unknown>>{
    if(this.loaded||this.closing)throw new Error('会话仓储已经打开或已关闭。');const database=new DatabaseClient(await ensureDatabase(this.path,this.codec));this.database=database;database.onFailure=error=>this.fail(error);
    try{
      const metadata=await database.call<{revision:number;initialized:boolean;source:{kind:string;sha256?:string};rows:EntityRow[]}>({action:'metadata'});
      if(!metadata.initialized||metadata.source?.kind!==this.codec.kind||metadata.rows.some(row=>row.table!=='state'))throw invalid('数据库类型或迁移状态与会话路径不匹配，请保留文件并核对。');
      await verifyMigrationSource(this.path,metadata.source);const stored=Object.fromEntries(metadata.rows.map(row=>[row.key,row.value])),entries=this.codec.validateEntries?this.codec.validateEntries(stored):validate(this.codec,this.codec.wrap(stored));
      if(Object.keys(entries).length>this.codec.maxEntries)throw invalid('会话数据库记录超过支持容量，请先整理。');
      this.revision=metadata.revision;this.ordinal=Math.max(0,...metadata.rows.map(row=>row.ordinal+1));this.loaded=true;return entries;
    }catch(error){await database.close();throw error;}
  }
  put(key:string,value:unknown):void {
    this.putMany([{key,value}]);
  }
  putMany(updates:Array<{key:string;value:unknown}>):void {
    if(this.failure)throw this.failure;if(!this.loaded||this.closing)throw new Error('会话仓储未打开或已关闭。');
    if(!updates.length)return;const changes=new Map<string,{change:EntityChange;bytes:number}>();
    for(const {key,value} of updates){const change:EntityChange={table:'state',key,...(value===undefined?{}:{value:structuredClone(value),ordinal:this.ordinal++})},bytes=Buffer.byteLength(JSON.stringify(change));if(key.length>1024||bytes>1024*1024)throw this.fail(Object.assign(new Error('单条会话写入超过支持容量。'),{code:'DATABASE_QUEUE_FULL'}));changes.set(key,{change,bytes});}
    let batch=this.batches.at(-1);const size=(target:typeof batch)=>[...(target?.changes??new Map()),...changes].reduce((map,[key,value])=>map.set(key,value),new Map<string,{change:EntityChange;bytes:number}>());
    let merged=size(batch),bytes=[...merged.values()].reduce((sum,item)=>sum+item.bytes,0);
    if(bytes>1024*1024||merged.size>256){batch=undefined;merged=changes;bytes=[...changes.values()].reduce((sum,item)=>sum+item.bytes,0);}
    if(bytes>1024*1024||merged.size>256||this.pendingBytes-(batch?.bytes??0)+bytes>8*1024*1024||!batch&&this.batches.length>=64)throw this.fail(Object.assign(new Error('会话写入队列超过支持容量，已停止继续写入。'),{code:'DATABASE_QUEUE_FULL'}));
    this.pendingBytes+=bytes-(batch?.bytes??0);if(batch){batch.changes=merged;batch.bytes=bytes;}else this.batches.push({changes:merged,bytes});
    if(!this.saving)void this.flush().catch(error=>this.fail(error));
  }
  private save():Promise<void>{
    this.saving=Promise.resolve().then(async()=>{
      while(this.batches.length){
        const batch=this.batches.shift()!;
        const result=await this.database!.call<{revision:number}>({action:'mutate',expectedRevision:this.revision,changes:[...batch.changes.values()].map(item=>item.change)});this.revision=result.revision;this.pendingBytes-=batch.bytes;
      }
    }).catch(error=>{throw this.fail(error);}).finally(()=>{this.saving=undefined;if(this.batches.length&&!this.failure)void this.flush().catch(error=>this.fail(error));});return this.saving;
  }
  async flush():Promise<void>{
    for(;;){if(this.failure)throw this.failure;if(!this.saving&&!this.batches.length)return;await(this.saving??this.save());}
  }
  close():Promise<void>{return this.closeTask??=(async()=>{this.closing=true;try{await this.flush();}finally{await this.database?.close();}})();}
}
