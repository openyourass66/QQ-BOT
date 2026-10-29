import {readFile,writeFile,mkdir,stat,statfs,link,unlink,rm,lstat,open} from 'node:fs/promises';
import {dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SocialDataSchema,type SocialData} from '../qq/social-store.js';
import {MemoryMetaSchema} from '../agent/cognition-state.js';
import {DatabaseClient} from './database-client.js';
import {dataFingerprint,emptySocialData,entityRows} from './social-entities.js';
import type {DatabaseRequest} from './database-types.js';

export type MigrationProgress={stage:'validate'|'backup'|'import'|'verify'|'activate';completed:number;total:number};
export const socialDatabasePath=(path:string)=>path+'.sqlite';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
async function sourceBytes(path:string):Promise<Buffer|undefined>{
  const info=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(!info)return;
  if(!info.isFile()||info.nlink>1||info.size>256*1024*1024)throw failure('DATABASE_INVALID','旧数据文件类型或大小超出支持范围，原文件保留。');return readFile(path);
}
export async function verifyMigrationSource(path:string,source:{sha256?:string|null}|undefined){
  if(!source)throw failure('DATABASE_INVALID','数据库缺少来源记录，请保留文件并使用恢复工具。');
  const raw=await sourceBytes(path);if(raw&&digest(raw)!==source.sha256)throw failure('DATABASE_INVALID','旧数据文件在迁移后发生变化，请保留两份数据并核对，不能覆盖现有数据库。');
}
export async function ensureSocialDatabase(path:string,onProgress?:(progress:MigrationProgress)=>void|Promise<void>):Promise<string>{
  const destination=socialDatabasePath(path),existing=await lstat(destination).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(existing){if(!existing.isFile()||existing.nlink>1)throw failure('DATABASE_INVALID','数据库路径不支持链接或非普通文件。');return destination;}
  await mkdir(dirname(path),{recursive:true});await onProgress?.({stage:'validate',completed:0,total:0});
  const raw=await sourceBytes(path),sha256=raw?digest(raw):null;let data:SocialData;
  if(raw){
    let parsed;try{parsed=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));}catch{throw failure('DATABASE_INVALID','旧数据文件损坏，原文件保留，请先修复或恢复备份。');}
    if(![1,2].includes(parsed?.version))throw failure('DATABASE_SCHEMA_NEWER','旧数据版本不受支持，请保留原文件并使用兼容版本。');
    data=SocialDataSchema.parse({...parsed,version:2});if(parsed.version===1)for(const memory of data.memories)data.cognition.memories[memory.id]??=MemoryMetaSchema.parse({confirmedAt:memory.at});
  }else data=emptySocialData();
  const fingerprint=dataFingerprint(data),metadata=entityRows(data),total=metadata.length+data.messages.length;
  const free=await statfs(dirname(path));if(free.bavail*free.bsize<Math.max((raw?.length??0)*3,64*1024*1024))throw failure('ENOSPC','磁盘空间不足以安全迁移，原文件保留。');
  if(raw){
    await onProgress?.({stage:'backup',completed:0,total});const backup=path+'.pre-sqlite-'+sha256!.slice(0,16)+'.bak';
    try{await writeFile(backup,raw,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(digest(await readFile(backup))!==sha256)throw failure('DATABASE_INVALID','迁移备份与原文件不一致，原文件保留。');
  }
  const staging=destination+'.migration-'+randomUUID(),client=new DatabaseClient(staging);let activated=false;
  try{
    type ImportRow=Extract<DatabaseRequest,{action:'import'}>['rows'][number];let batch:ImportRow[]=[],bytes=0,completed=0;
    const flush=async()=>{if(!batch.length)return;await client.call({action:'import',rows:batch});completed+=batch.length;batch=[];bytes=0;await onProgress?.({stage:'import',completed,total});};
    for(const row of [...metadata,...data.messages.map((value,ordinal)=>({table:'messages' as const,key:`${value.chat}/${value.id}`,ordinal,value}))]){
      const size=Buffer.byteLength(JSON.stringify(row));if(size>1024*1024)throw failure('DATABASE_INVALID','单条旧记录过大，原文件保留，请先导出整理。');
      if(batch.length>=256||bytes+size>1024*1024)await flush();batch.push(row);bytes+=size;
    }await flush();await client.open();
    await onProgress?.({stage:'verify',completed,total});const check=await client.call<{check:string[]}>({action:'integrity'}),actual=await client.call<{sha256:string}>({action:'fingerprint'});
    if(check.check.join(',')!=='ok'||actual.sha256!==fingerprint)throw failure('DATABASE_INVALID','迁移完整性校验未通过，原文件与备份保留。');
    await client.call({action:'complete-import',source:{kind:'social',formatVersion:1,file:basename(path),sha256,normalizedSha256:fingerprint,migratedAt:new Date().toISOString()}});await client.close();
    if(raw?digest(await readFile(path))!==sha256:await stat(path).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;}))throw failure('DATABASE_INVALID','迁移期间原文件发生变化，已取消切换，请停止其他写入者后重试。');
    await onProgress?.({stage:'activate',completed,total});const handle=await open(staging,'r+');try{await handle.sync();}finally{await handle.close();}
    // 同目录硬链接提供不覆盖的发布；数据库连接全部关闭后才激活。
    await link(staging,destination);await unlink(staging);activated=true;return destination;
  }finally{
    await client.close().catch(()=>{});if(!activated)for(const suffix of ['','-wal','-shm'])await rm(staging+suffix,{force:true}).catch(()=>{});
  }
}
