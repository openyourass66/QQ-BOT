import {createReadStream,createWriteStream,constants} from 'node:fs';
import {readFile,writeFile,open,lstat,realpath,mkdir,readdir,rename,rm,mkdtemp,statfs,utimes} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID,scrypt as derive,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify,parseEnv} from 'node:util';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {DatabaseSync,backup as backupDatabase} from 'node:sqlite';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {DATABASE_SCHEMA_VERSION} from '../dist/storage/database-types.js';
import {canonicalRuntimePath} from './app-paths.mjs';

const scrypt=promisify(derive),magic=Buffer.from('WHALEBK1\n'),journalName='.restore-journal.json';
const limits={files:50000,bytes:10*1024**3,line:131072};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(message,code='MAINTENANCE_INVALID')=>Object.assign(new Error(message),{code});
const canonical=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const inside=(root,path)=>{const rel=relative(root,path);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
const optional=path=>lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
const check=options=>options.signal?.throwIfAborted();
const progress=(options,stage,files=0,bytes=0)=>{if(stage!=='complete')check(options);options.onProgress?.({stage,files,bytes});};
function password(value){if(typeof value!=='string'||value.length<12||value.length>512)throw fail('备份密码须为 12–512 个字符，请妥善保存。');return value;}
async function safePath(path){
  for(let current=resolve(path);;current=dirname(current)){
    const info=await optional(current);if(info?.isSymbolicLink())throw fail('维护路径包含链接，请选择实际目录。');
    if(dirname(current)===current)break;
  }
  return canonicalRuntimePath(resolve(path));
}
async function regular(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw fail('备份数据包含链接或非普通文件，已保留原数据。');return info;}
function validName(name){return typeof name==='string'&&name.length<=4096&&!name.includes('\\')&&!name.includes('\0')&&!name.includes(':')&&(!name||name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));}
async function entries(path,kind,options={}){
  const info=await optional(path);if(!info)return null;
  if(info.isSymbolicLink()||kind==='directory'&&!info.isDirectory()||kind==='file'&&!info.isFile())throw fail('维护数据路径类型无效，原数据保留。');
  const result=[];let bytes=0;
  const walk=async(file,name,depth)=>{
    check(options);if(depth>32||result.length>=limits.files)throw fail('备份文件数量或目录深度超出支持范围。');
    const item=await lstat(file);if(item.isSymbolicLink()||!validName(name))throw fail('备份包含链接或不支持的文件名称。');
    if(item.isDirectory()){
      result.push({name,kind:'directory'});
      for(const child of (await readdir(file)).sort())await walk(join(file,child),name?name+'/'+child:child,depth+1);
    }else{
      await regular(file);bytes+=item.size;if(bytes>limits.bytes)throw fail('备份数据超过 10 GiB 支持上限，请先整理或分离数据。');
      result.push({name,kind:'file',size:item.size,mtime:item.mtimeMs});
    }
  };
  await walk(path,'',0);return result;
}
async function fileHash(path,options={}){
  await regular(path);const digest=createHash('sha256');
  for await(const chunk of createReadStream(path,{flags:constants.O_RDONLY|(constants.O_NOFOLLOW??0)})){check(options);digest.update(chunk);}
  return digest.digest('hex');
}
async function fingerprint(path,kind,options={}){
  const list=await entries(path,kind,options);if(list===null)return null;
  const digest=createHash('sha256');for(const item of list){digest.update(JSON.stringify([item.kind,item.name,item.size??0]));if(item.kind==='file')digest.update(await fileHash(item.name?join(path,item.name):path,options));}
  return digest.digest('hex');
}
async function layout(dataRoot,raw){
  dataRoot=await realpath(dataRoot);const env=parseEnv(raw),paths=dataPaths(env,dataRoot),workspace=resolve(dataRoot,env.BOT_WORKSPACE||'bot-workspace');
  const specs=[{id:'settings',path:resolve(dataRoot,env.BOT_SETTINGS_FILE||'bot.config.json'),kind:'file'},
    {id:'persona',path:join(workspace,'AGENTS.md'),kind:'file'},
    {id:'personas',path:join(workspace,'.whale'),kind:'directory'},
    {id:'memory',path:join(workspace,'memory'),kind:'directory'},
    {id:'media',path:paths.media,kind:'directory'},
    {id:'credentials',path:join(dataRoot,'.credentials'),kind:'directory'}];
  for(const key of ['sessions','groupContext','usage','social']){
    specs.push({id:key+'-legacy',path:paths[key],kind:'file'});
    specs.push({id:key+'-db',path:paths[key]+'.sqlite',kind:'file',sqlite:true});
    for(const suffix of ['-wal','-shm'])specs.push({id:key+suffix,path:paths[key]+'.sqlite'+suffix,kind:'file',transient:true});
  }
  specs.push({id:'env',path:join(dataRoot,'.env'),kind:'file'});
  for(const spec of specs){await safePath(spec.path);spec.path=await canonicalRuntimePath(spec.path);}
  for(let i=0;i<specs.length;i++)for(let j=0;j<i;j++){
    const a=specs[i],b=specs[j];if(canonical(a.path)===canonical(b.path)||a.kind==='directory'&&inside(canonical(a.path),canonical(b.path))||b.kind==='directory'&&inside(canonical(b.path),canonical(a.path)))throw fail('数据路径互相重叠，无法安全备份与恢复；请使用独立的数据、记忆和媒体位置。');
  }
  return {dataRoot,raw,paths,specs};
}
async function context(dataRoot,{recovery=false,...options}={}){
  dataRoot=await realpath(resolve(dataRoot));let journal;
  if(await optional(join(dataRoot,journalName))){
    if(!recovery)throw fail('上次恢复尚未收尾，请先处理恢复中断。','MAINTENANCE_RECOVERY_REQUIRED');
    await regular(join(dataRoot,journalName));if((await lstat(join(dataRoot,journalName))).size>65536)throw fail('恢复记录过大，原数据保留。');
    journal=JSON.parse(await readFile(join(dataRoot,journalName),'utf8'));
    if(journal.version!==1||! /^[a-f0-9-]{36}$/.test(journal.id)||!['switching','committed'].includes(journal.state)||!Array.isArray(journal.entries))throw fail('恢复记录无效，原数据保留。');
  }
  const previousEnv=journal?join(dataRoot,'.whale-before-'+journal.id+'-env'):null;
  const raw=await readFile(previousEnv&&await optional(previousEnv)?previousEnv:join(dataRoot,'.env'),'utf8');
  const value=await layout(dataRoot,raw),resources=[...mutableDataResources(value.paths,recovery),{path:join(dataRoot,'.env'),label:'连接配置'},...value.specs.filter(s=>!s.transient&&!s.sqlite).map(s=>({path:s.path,label:'备份与恢复数据'}))];
  const lease=await acquireDataResources(resources,options.signal);
  try{const current=await readFile(previousEnv&&await optional(previousEnv)?previousEnv:join(dataRoot,'.env'),'utf8');if(current!==raw)throw fail('维护期间配置已改变，请重新开始。');return {...value,lease,journal};}catch(error){lease.release();throw error;}
}
async function checkSpace(parent,bytes){const free=await statfs(parent);if(free.bavail*free.bsize<bytes+64*1024*1024)throw fail('磁盘空间不足，已保留原数据。','ENOSPC');}
async function syncFile(path){const handle=await open(path,'r+');try{await handle.sync();}finally{await handle.close();}}
async function writeAll(handle,bytes){let offset=0;while(offset<bytes.length){const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset);if(!bytesWritten)throw fail('写入未完成，当前数据已保留。','ENOSPC');offset+=bytesWritten;}}
function validateDatabase(path){
  const db=new DatabaseSync(path,{readOnly:true});
  try{const version=Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);if(version>DATABASE_SCHEMA_VERSION)throw fail('备份数据库版本较新，请使用兼容的程序版本。');if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok'))throw fail('备份数据库完整性检查未通过。');return version;}finally{db.close();}
}
async function validateSnapshot(archive){
  for(const item of Object.values(archive.parsed))if(item.sqlite&&item.exists)validateDatabase(item.staged);
  const env=archive.parsed.env;if(!env?.exists)throw fail('备份缺少连接配置。');
  const {validateRuntimeEnv}=await import('../desktop/runtime-fields.mjs');validateRuntimeEnv(await readFile(env.staged,'utf8'));
  const settings=archive.parsed.settings;
  if(settings?.exists){const info=await regular(settings.staged);if(info.size>2*1024*1024)throw fail('备份中的机器人设置过大。');try{const {validateSettings}=await import('../dist/core/settings.js');validateSettings(JSON.parse(await readFile(settings.staged,'utf8')));}catch{throw fail('备份中的机器人设置损坏或不受支持，当前数据未切换。');}}
}
async function journalWrite(ctx,journal){
  const path=join(ctx.dataRoot,journalName),temporary=path+'.tmp-'+randomUUID();
  try{await writeFile(temporary,JSON.stringify(journal),{flag:'wx',mode:0o600});await syncFile(temporary);await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
function auxiliary(spec,id,prefix){return join(dirname(spec.path),'.whale-'+prefix+'-'+id+'-'+spec.id);}
async function removeOwned(path,expected,kind){
  if(!await optional(path))return;if(expected!==undefined&&await fingerprint(path,kind)!==expected)throw fail('维护暂存内容已改变，已保留文件供核对。');
  if((await lstat(path)).isSymbolicLink())throw fail('维护暂存位置被替换，已保留文件。');
  await rm(path,{recursive:kind==='directory',force:true});
}
async function temporaryRoot(){const parent=await realpath(tmpdir()),path=await mkdtemp(join(parent,'qq-maintenance-'));return {path,async remove(){if(!await optional(path))return;const actual=await realpath(path);if(dirname(actual)!==parent||!basename(actual).startsWith('qq-maintenance-'))throw fail('维护暂存目录位置改变，已保留。');await rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};}

async function backupLocked(ctx,output,secret,options={}){
  check(options);output=await safePath(resolve(output));await safePath(dirname(output));
  if(await optional(output))throw fail('备份目标已存在，请选择新的文件名。');
  for(const spec of ctx.specs)if(canonical(spec.path)===canonical(output)||spec.kind==='directory'&&inside(canonical(spec.path),canonical(output)))throw fail('备份文件不能保存在被备份的数据目录内。');
  await mkdir(dirname(output),{recursive:true});const scratch=await temporaryRoot(),temporary=output+'.partial-'+randomUUID();
  const salt=randomBytes(16),iv=randomBytes(12),key=await scrypt(password(secret),salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const header=Buffer.from(JSON.stringify({version:1,kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64')})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);
  const aad=Buffer.concat([magic,length,header]),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
  let files=0,bytes=0,records=0;const rawGroups=new Set();
  const line=value=>{const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>limits.line)throw fail('备份清单或记录过大，请精简目录布局。');return bytes;};
  async function* encode(){
    yield line({type:'manifest',version:1,appVersion:'0.2.0',instance:ctx.dataRoot,layout:ctx.specs,createdAt:new Date().toISOString()});
    for(const spec of ctx.specs){
      progress(options,'reading',files,bytes);let source=spec.path,list=spec.transient&&!rawGroups.has(spec.id.replace(/-(?:wal|shm)$/, ''))?null:await entries(source,spec.kind,options),original,schemaVersion;
      if(list&&spec.sqlite){
        original=await fingerprint(source,'file',options);const snapshot=join(scratch.path,spec.id);let db;
        try{db=new DatabaseSync(source,{readOnly:true});schemaVersion=Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok'))throw fail('数据库完整性检查未通过，原文件保留。');await backupDatabase(db,snapshot,{rate:256,progress:()=>check(options)});source=snapshot;list=await entries(source,'file',options);}
        catch(error){check(options);if(!options.preserveInvalid)throw error;rawGroups.add(spec.id.slice(0,-3));}
        finally{db?.close();}
      }
      const before=spec.transient?null:original??await fingerprint(spec.path,spec.kind,options);
      yield line({type:'target',id:spec.id,exists:list!==null,...(schemaVersion===undefined?{}:{schemaVersion})});
      for(const item of list??[]){
        if(++records>limits.files)throw fail('备份条目超过五万项支持上限。');
        if(item.kind==='directory'){yield line({type:'directory',name:item.name});continue;}
        bytes+=item.size;if(bytes>limits.bytes)throw fail('备份数据超过 10 GiB 支持上限。');files++;
        await checkSpace(dirname(output),Math.min(bytes,limits.bytes));yield line({type:'file',name:item.name,size:item.size,mtime:item.mtime});
        const path=item.name?join(source,item.name):source,info=await regular(path),digest=createHash('sha256');let count=0;
        for await(const chunk of createReadStream(path,{highWaterMark:65536,flags:constants.O_RDONLY|(constants.O_NOFOLLOW??0)})){check(options);digest.update(chunk);count+=chunk.length;yield line({type:'chunk',data:chunk.toString('base64')});}
        const after=await regular(path);if(count!==item.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ino!==info.ino)throw fail('备份期间文件发生变化，请停止编辑后重试。');
        yield line({type:'end-file',sha256:digest.digest('hex')});
      }
      if(!spec.transient&&await fingerprint(spec.path,spec.kind,options)!==before)throw fail('备份期间数据发生变化，请停止编辑后重试。');
    }
    yield line({type:'complete',files,bytes});
  }
  try{
    await writeFile(temporary,aad,{flag:'wx',mode:0o600});
    await pipeline(Readable.from(encode()),createGzip(),cipher,createWriteStream(temporary,{flags:'a'}),{signal:options.signal});
    const handle=await open(temporary,'a');try{await writeAll(handle,cipher.getAuthTag());await handle.sync();}finally{await handle.close();}
    check(options);if(await optional(output))throw fail('备份目标在保存期间已存在，本次不覆盖。');
    // 排他链接发布，避免覆盖另一个操作刚创建的备份。
    const {link,unlink}=await import('node:fs/promises');await link(temporary,output);await unlink(temporary);progress(options,'complete',files,bytes);
    return {operation:'backup',file:output,files,bytes};
  }catch(error){if(options.signal?.aborted)throw options.signal.reason;throw error;}
  finally{key.fill(0);await rm(temporary,{force:true});await scratch.remove();}
}

async function decodeArchive(file,secret,options={}){
  file=await safePath(resolve(file));const info=await regular(file);if(info.size<64||info.size>limits.bytes*2)throw fail('备份文件大小无效。');
  const input=await open(file,'r'),fixed=Buffer.alloc(magic.length+4);let aad,key,tag;
  try{
    await input.read(fixed,0,fixed.length,0);if(!fixed.subarray(0,magic.length).equals(magic))throw fail('这不是受支持的加密备份。');
    const size=fixed.readUInt32BE(magic.length);if(size<1||size>4096||info.size<=fixed.length+size+16)throw fail('备份头部无效。');
    const raw=Buffer.alloc(size);await input.read(raw,0,size,fixed.length);const header=JSON.parse(raw.toString('utf8'));
    if(header.version!==1||header.kdf!=='scrypt-32768-8-1'||typeof header.salt!=='string'||typeof header.iv!=='string'||Buffer.from(header.salt,'base64').length!==16||Buffer.from(header.iv,'base64').length!==12)throw fail('备份加密格式不受支持。');
    aad=Buffer.concat([fixed,raw]);key=await scrypt(password(secret),Buffer.from(header.salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});tag=Buffer.alloc(16);await input.read(tag,0,16,info.size-16);
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(header.iv,'base64'));decipher.setAAD(aad);decipher.setAuthTag(tag);
    const scratch=await temporaryRoot();let manifest,current,active,complete=false,files=0,bytes=0,records=0,handle,seenTargets=new Set(),seenNames=new Set();
    const parsed={};
    const consume=async record=>{
      check(options);if(complete)throw fail('备份结束标记后仍有数据。');
      if(!manifest){if(record.type!=='manifest'||record.version!==1||record.appVersion!=='0.2.0'||typeof record.instance!=='string'||!Array.isArray(record.layout)||record.layout.length>32)throw fail('备份清单版本无效。');manifest=record;return;}
      if(record.type==='target'){
        if(active||typeof record.id!=='string'||! /^[a-zA-Z0-9-]+$/.test(record.id)||seenTargets.has(record.id)||typeof record.exists!=='boolean')throw fail('备份数据组无效。');
        const spec=manifest.layout.find(spec=>spec.id===record.id);if(!spec||!['file','directory'].includes(spec.kind))throw fail('备份数据组未登记。');
        seenTargets.add(record.id);seenNames=new Set();current={...spec,exists:record.exists,staged:join(scratch.path,record.id)};parsed[record.id]=current;
        if(record.exists&&spec.kind==='directory')await mkdir(current.staged);return;
      }
      if(record.type==='complete'){
        if(active||seenTargets.size!==manifest.layout.length||record.files!==files||record.bytes!==bytes)throw fail('备份内容不完整。');
        for(const item of Object.values(parsed))if(item.exists&&!await optional(item.staged))throw fail('备份数据文件缺失。');complete=true;return;
      }
      if(!current?.exists)throw fail('备份条目缺少有效的数据组。');
      if(record.type==='file'||record.type==='directory'){
        if(active||!validName(record.name)||current.kind==='file'&&(record.name!==''||record.type!=='file')||++records>limits.files)throw fail('备份文件路径或数量无效。');
        const name=record.name.toLowerCase();if(seenNames.has(name))throw fail('备份包含重复文件路径。');seenNames.add(name);
        const path=record.name?join(current.staged,record.name):current.staged;if(!inside(current.staged,path))throw fail('备份文件越界。');
        if(record.type==='directory'){await mkdir(path,{recursive:true});return;}
        if(!Number.isSafeInteger(record.size)||record.size<0||record.size>limits.bytes||!Number.isFinite(record.mtime)||record.mtime<0)throw fail('备份文件大小或时间无效。');
        bytes+=record.size;if(bytes>limits.bytes)throw fail('备份解包超过 10 GiB 支持上限。');await checkSpace(scratch.path,record.size);await mkdir(dirname(path),{recursive:true});
        handle=await open(path,'wx',0o600);active={path,size:record.size,written:0,mtime:record.mtime,digest:createHash('sha256')};return;
      }
      if(record.type==='chunk'){
        if(!active||typeof record.data!=='string'||record.data.length>87384||! /^[A-Za-z0-9+/]*={0,2}$/.test(record.data))throw fail('备份文件分块无效。');
        const chunk=Buffer.from(record.data,'base64');active.written+=chunk.length;if(active.written>active.size)throw fail('备份文件超出声明大小。');await writeAll(handle,chunk);active.digest.update(chunk);return;
      }
      if(record.type==='end-file'){
        if(!active||active.written!==active.size||record.sha256!==active.digest.digest('hex'))throw fail('备份文件摘要不一致。');await handle.sync();await handle.close();handle=undefined;await utimes(active.path,new Date(active.mtime),new Date(active.mtime));active=undefined;files++;progress(options,'verifying',files,bytes);return;
      }
      throw fail('备份包含未知记录。');
    };
    try{
      await pipeline(createReadStream(file,{start:aad.length,end:info.size-17}),decipher,createGunzip(),async source=>{
        let pending=Buffer.alloc(0);for await(const chunk of source){check(options);pending=Buffer.concat([pending,chunk]);let index;while((index=pending.indexOf(10))!==-1){if(index>limits.line)throw fail('备份记录过大。');const row=pending.subarray(0,index);pending=pending.subarray(index+1);await consume(JSON.parse(row.toString('utf8')));}if(pending.length>limits.line)throw fail('备份记录过大。');}if(pending.length)throw fail('备份记录未完整结束。');
      },{signal:options.signal});
      if(!complete)throw fail('备份内容未完整结束。');
      return {manifest,parsed,files,bytes,scratch};
    }catch(error){await handle?.close();await scratch.remove();if(options.signal?.aborted)throw options.signal.reason;throw fail('备份密码错误、内容损坏或格式不受支持；当前数据未切换。');}
  }finally{await input.close();key?.fill(0);}
}

export async function createBackup({dataRoot,file,password:secret,...options}){
  password(secret);
  const ctx=await context(dataRoot,options);try{return await backupLocked(ctx,file,secret,options);}finally{ctx.lease.release();}
}
export async function verifyBackup({file,password:secret,...options}){
  const archive=await decodeArchive(file,secret,options);try{
    await validateSnapshot(archive);
    return {operation:'verify',files:archive.files,bytes:archive.bytes,createdAt:archive.manifest.createdAt};
  }finally{await archive.scratch.remove();}
}
function validateJournal(ctx,journal){
  if(journal.entries.length!==ctx.specs.length)throw fail('恢复记录数据组不完整。');
  const ids=new Set();for(const entry of journal.entries){
    const spec=ctx.specs.find(spec=>spec.id===entry.id);if(!spec||ids.has(entry.id)||canonical(entry.target)!==canonical(spec.path)||entry.kind!==spec.kind||entry.previous!==auxiliary(spec,journal.id,'before')||entry.staged!==auxiliary(spec,journal.id,'restore')||![entry.old,entry.next].every(value=>value===null||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw fail('恢复记录路径或摘要无效，保留文件供核对。');ids.add(entry.id);
  }
}
async function finishJournal(ctx,journal){
  validateJournal(ctx,journal);
  for(const entry of journal.entries){
    const previous=await optional(entry.previous),target=await optional(entry.target);
    if(journal.state==='committed'){
      if(await fingerprint(entry.target,entry.kind)!==entry.next)throw fail('恢复后的数据已改变，不能自动清理旧恢复点。');
      if(previous)await removeOwned(entry.previous,entry.old,entry.kind);
    }else if(previous){
      if(await fingerprint(entry.previous,entry.kind)!==entry.old)throw fail('原数据恢复点已改变，已保留所有文件。');
      if(target){if(await optional(entry.staged))throw fail('恢复暂存和目标同时存在，已保留文件。');if(await fingerprint(entry.target,entry.kind)!==entry.next)throw fail('恢复中断后数据已被编辑，已保留新旧两份文件。');await rename(entry.target,entry.staged);}
      await rename(entry.previous,entry.target);
    }else if(entry.old===null){
      if(target){if(await optional(entry.staged)||await fingerprint(entry.target,entry.kind)!==entry.next)throw fail('恢复目标已改变，已保留文件。');await rename(entry.target,entry.staged);}
    }else if(await fingerprint(entry.target,entry.kind)!==entry.old)throw fail('原数据位置异常，已保留恢复记录。');
  }
  for(const entry of journal.entries)await removeOwned(entry.staged,entry.next,entry.kind);
  if(journal.scratch){const parent=await realpath(tmpdir());if(dirname(journal.scratch)!==parent||!/^qq-maintenance-[\w-]+$/.test(basename(journal.scratch)))throw fail('恢复暂存目录记录无效。');await removeOwned(journal.scratch,journal.scratchFingerprint,'directory');}
  await rm(join(ctx.dataRoot,journalName));
}
export async function recoverMaintenance({dataRoot,...options}){
  const ctx=await context(dataRoot,{...options,recovery:true});try{if(!ctx.journal)return {operation:'recover',recovered:false};await finishJournal(ctx,ctx.journal);return {operation:'recover',recovered:true,committed:ctx.journal.state==='committed'};}finally{ctx.lease.release();}
}
export async function maintenanceStatus(dataRoot){return {operation:'status',recoveryPending:!!await optional(join(resolve(dataRoot),journalName))};}

export async function restoreBackup({dataRoot,file,password:secret,...options}){
  password(secret);
  const ctx=await context(dataRoot,options);let archive,journal,recoveryPoint;const preparedStages=[];
  try{
    const input=await safePath(resolve(file));
    if(ctx.specs.some(spec=>canonical(spec.path)===canonical(input)||spec.kind==='directory'&&inside(canonical(spec.path),canonical(input))))throw fail('请将备份文件移到待恢复数据目录之外，再执行恢复。');
    progress(options,'verifying');archive=await decodeArchive(file,secret,options);
    if(canonical(archive.manifest.instance)!==canonical(ctx.dataRoot)||JSON.stringify(archive.manifest.layout)!==JSON.stringify(ctx.specs))throw fail('本备份仅能恢复到原实例及相同数据路径；跨目录或跨机器搬迁需另行迁移。');
    const restoredEnv=await readFile(archive.parsed.env.staged,'utf8'),restoredLayout=await layout(ctx.dataRoot,restoredEnv);
    if(JSON.stringify(restoredLayout.specs)!==JSON.stringify(ctx.specs))throw fail('备份配置中的数据路径与当前实例不一致。');
    await validateSnapshot(archive);
    recoveryPoint=join(ctx.dataRoot,'backups','before-restore-'+Date.now()+'-'+randomUUID()+'.wwbackup');
    progress(options,'recovery-point');await backupLocked(ctx,recoveryPoint,secret,{...options,preserveInvalid:true,onProgress:event=>options.onProgress?.({...event,stage:'recovery-point'})});
    journal={version:1,id:randomUUID(),state:'switching',scratch:archive.scratch.path,scratchFingerprint:await fingerprint(archive.scratch.path,'directory',options),entries:[]};
    for(const spec of ctx.specs){
      check(options);const item=archive.parsed[spec.id],staged=auxiliary(spec,journal.id,'restore'),previous=auxiliary(spec,journal.id,'before');
      if(await optional(staged)||await optional(previous))throw fail('恢复暂存位置已存在，请核对后重试。');
      preparedStages.push({path:staged,kind:spec.kind});
      await mkdir(dirname(spec.path),{recursive:true});await checkSpace(dirname(spec.path),archive.bytes);
      if(item.exists){
        const {cp}=await import('node:fs/promises');await cp(item.staged,staged,{recursive:spec.kind==='directory',errorOnExist:true,force:false});
        if(spec.sqlite)validateDatabase(staged);
      }
      journal.entries.push({id:spec.id,target:spec.path,kind:spec.kind,staged,previous,old:await fingerprint(spec.path,spec.kind,options),next:await fingerprint(staged,spec.kind,options)});
    }
    validateJournal(ctx,journal);await journalWrite(ctx,journal);options.checkpoint?.('prepared');
    for(const entry of journal.entries){
      progress(options,'switching');if(await fingerprint(entry.target,entry.kind)!==entry.old)throw fail('恢复切换前数据发生变化，已停止切换。');
      if(entry.old!==null)await rename(entry.target,entry.previous);options.checkpoint?.('original-moved',entry.id);
      if(entry.next!==null)await rename(entry.staged,entry.target);options.checkpoint?.('installed',entry.id);
    }
    await journalWrite(ctx,{...journal,state:'committed'});journal.state='committed';options.checkpoint?.('committed');await finishJournal(ctx,journal);
    progress(options,'complete',archive.files,archive.bytes);return {operation:'restore',files:archive.files,bytes:archive.bytes,recoveryPoint,restartRequired:true};
  }catch(error){
    if(journal&&await optional(join(ctx.dataRoot,journalName))){try{await finishJournal(ctx,journal);}catch{throw fail('恢复未收尾，已保留恢复点；请使用“处理上次中断”，完成前不能启动机器人。','MAINTENANCE_RECOVERY_REQUIRED');}}
    throw error;
  }finally{
    try{
      if(!await optional(join(ctx.dataRoot,journalName)))for(const item of preparedStages){const entry=journal?.entries.find(entry=>entry.staged===item.path);await removeOwned(item.path,entry?.next,item.kind);}
      await archive?.scratch.remove();
    }finally{ctx.lease.release();}
  }
}
