import {createHash,randomUUID} from 'node:crypto';
import {opendir,lstat,open,link,unlink,mkdir,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {MemoryMediaCacheStore} from '../storage/memory-media-cache.js';
import {ownedMediaName,safeMediaName,type MediaCacheEntry,type MediaCacheStore,type MediaCacheStatistics,type StoredMediaCacheEntry} from '../storage/media-cache-types.js';

const fileSystem={opendir,lstat,open,link,unlink,mkdir,realpath};
type Options={fs?:Partial<typeof fileSystem>;now?:()=>number;limit?:()=>number;onFailure?:(error:Error)=>void;signal?:AbortSignal;preserveTemporary?:boolean;check?:()=>void};
export const MEDIA_WRITE_LIMITS={pending:8,bytes:128*1024*1024,file:50_000_000};
const absent=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';

export class MediaCache {
  readonly root:string;
  private readonly fs:typeof fileSystem;
  private loaded=false;private epoch=0;private loading?:Promise<void>;
  private chain:Promise<unknown>=Promise.resolve();private pending=0;private pendingBytes=0;
  private failure?:Error;
  constructor(root:string,private store:MediaCacheStore=new MemoryMediaCacheStore(),private options:Options={}){this.root=resolve(root);this.fs={...fileSystem,...options.fs};}
  get queued(){return this.pending;}
  get queuedBytes(){return this.pendingBytes;}
  private limit(){const limit=this.options.limit?.()??Number(process.env.BOT_MEDIA_MAX_BYTES||536870912);if(!Number.isSafeInteger(limit)||limit<0)throw new Error('BOT_MEDIA_MAX_BYTES 必须是非负整数');return limit;}
  private path(name:string){if(!safeMediaName(name))throw new Error('媒体缓存文件名无效');const path=resolve(this.root,name),rel=relative(this.root,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('媒体缓存路径越界');return path;}
  private enqueue<T>(operation:()=>Promise<T>,bytes=0):Promise<T>{
    if(this.failure)return Promise.reject(this.failure);
    if(this.pending>=MEDIA_WRITE_LIMITS.pending||this.pendingBytes+bytes>MEDIA_WRITE_LIMITS.bytes)return Promise.reject(Object.assign(new Error('媒体正在保存，请稍后重试'),{code:'MEDIA_WRITE_BUSY'}));
    this.pending++;this.pendingBytes+=bytes;const task=this.chain.then(()=>{if(this.failure)throw this.failure;return operation();});this.chain=task.catch(()=>{});
    return task.catch(error=>{if(['ENOSPC','EIO','EROFS'].includes(error?.code))this.fail(error);throw error;}).finally(()=>{this.pending--;this.pendingBytes-=bytes;});
  }
  private fail(error:unknown){if(this.failure)return;this.failure=error instanceof Error?error:new Error('媒体缓存结果待核对');this.options.onFailure?.(this.failure);}
  save(buffer:Buffer,extension:string):Promise<string>{
    if(this.failure)return Promise.reject(this.failure);
    if(!/^\.[a-z0-9]{1,10}$/i.test(extension))return Promise.reject(new Error('媒体文件扩展名无效'));
    if(buffer.length>MEDIA_WRITE_LIMITS.file)return Promise.reject(new Error('媒体文件超过单次保存大小上限'));
    if(this.pending>=MEDIA_WRITE_LIMITS.pending||this.pendingBytes+buffer.length>MEDIA_WRITE_LIMITS.bytes)return Promise.reject(Object.assign(new Error('媒体正在保存，请稍后重试'),{code:'MEDIA_WRITE_BUSY'}));
    const copy=Buffer.from(buffer);return this.enqueue(()=>this.write(copy,extension.toLowerCase()),copy.length);
  }
  reconcile():Promise<MediaCacheStatistics>{this.loaded=false;this.epoch++;return this.enqueue(async()=>{await this.ensure();return this.store.call({action:'media-cache-statistics'});});}
  async statistics():Promise<MediaCacheStatistics>{await this.ensure();return this.store.call({action:'media-cache-statistics'});}
  touch(name:string):Promise<void>{return this.enqueue(async()=>{if(!ownedMediaName(name))return;await this.ensure();await this.store.call({action:'media-cache-touch',name,at:(this.options.now??Date.now)()});});}
  async flush():Promise<void>{for(;;){const current=this.chain;await current;if(current===this.chain)return;}}
  private async ensure(){
    if(this.loaded)return;
    await (this.loading??=(async()=>{while(!this.loaded){const epoch=this.epoch;await this.scan();this.loaded=epoch===this.epoch;}})().finally(()=>{this.loading=undefined;}));
  }
  private async scan(){
    this.options.check?.();
    this.options.signal?.throwIfAborted();
    const owner=randomUUID();
    await this.fs.mkdir(this.root,{recursive:true});const actual=await this.fs.realpath(this.root),root=process.platform==='win32'?actual.toLowerCase():actual;
    const {stale}=await this.store.call<{stale:Array<{name:string;owner:string;fileTag:string}>}>({action:'media-cache-scan-start',root,owner});
    try{
      for(const row of stale){this.options.signal?.throwIfAborted();if(this.options.preserveTemporary||!ownedMediaName(row.name)||!/^[a-f0-9-]{36}$/i.test(row.owner)||!row.fileTag)continue;const temp=this.path(`${row.name}.${row.owner}.tmp`),info=await this.fs.lstat(temp,{bigint:true}).catch(error=>{if(!absent(error))throw error;return undefined;});if(info?.isFile()&&!info.isSymbolicLink()&&`${info.dev}:${info.ino}`===row.fileTag)await this.fs.unlink(temp);}
      const directory=await this.fs.opendir(this.root);let entries:MediaCacheEntry[]=[];
      try{for await(const entry of directory){this.options.check?.();this.options.signal?.throwIfAborted();if(!entry.isFile())continue;const path=this.path(entry.name),info=await this.fs.lstat(path).catch(error=>{if(!absent(error))throw error;return undefined;});if(!info?.isFile()||info.isSymbolicLink())continue;
        entries.push({name:entry.name,size:info.size,mtime:info.mtimeMs,owned:ownedMediaName(entry.name)&&info.nlink===1});if(entries.length===128){await this.store.call({action:'media-cache-scan-batch',owner,entries});entries=[];}
      }}finally{await directory.close().catch(()=>{});}
      if(entries.length)await this.store.call({action:'media-cache-scan-batch',owner,entries});await this.store.call({action:'media-cache-scan-complete',owner});
    }catch(error){await this.store.call({action:'media-cache-scan-abort',owner}).catch(()=>{});throw error;}
  }
  private async matches(file:string,buffer:Buffer,digest:string){
    const info=await this.fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==buffer.length)throw new Error('同名媒体缓存与内容摘要不一致或不支持链接，请保留文件并检查媒体库');
    const handle=await this.fs.open(file,'r'),hash=createHash('sha256'),chunk=Buffer.alloc(65536);let size=0;
    try{for(;;){const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;size+=bytesRead;if(size>buffer.length)throw new Error('媒体缓存读取期间发生变化');hash.update(chunk.subarray(0,bytesRead));}}finally{await handle.close();}
    if(size!==buffer.length||hash.digest('hex')!==digest)throw new Error('同名媒体缓存与内容摘要不一致，请保留文件并检查媒体库');
  }
  private async write(buffer:Buffer,extension:string):Promise<string>{
    this.limit();await this.ensure();const digest=createHash('sha256').update(buffer).digest('hex'),name=digest+extension,file=this.path(name),owner=randomUUID(),temp=this.path(`${name}.${owner}.tmp`);
    const existing=await this.fs.lstat(file).catch(error=>{if(!absent(error))throw error;return undefined;}),record=await this.store.call<StoredMediaCacheEntry|null>({action:'media-cache-read',name});
    if(existing){await this.matches(file,buffer,digest);if(record?.state==='reserved'||record?.state==='stale')throw new Error('同名媒体仍在保存或待核对');if(!record){this.loaded=false;await this.ensure();}await this.store.call({action:'media-cache-touch',name,at:(this.options.now??Date.now)()});return file;}
    if(record?.state==='complete')await this.store.call({action:'media-cache-forget',name});
    await this.store.call({action:'media-cache-reserve',name,size:buffer.length,limit:this.limit(),owner});let published=false,created=false;
    try{
      const handle=await this.fs.open(temp,'wx',0o600);created=true;try{const info=await handle.stat({bigint:true});await this.store.call({action:'media-cache-stage',name,owner,fileTag:`${info.dev}:${info.ino}`});await handle.writeFile(buffer);await handle.sync();}finally{await handle.close();}
      try{await this.fs.link(temp,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.matches(file,buffer,digest);}
      published=true;await this.fs.unlink(temp);created=false;const info=await this.fs.lstat(file);await this.store.call({action:'media-cache-complete',name,owner,mtime:info.mtimeMs,at:(this.options.now??Date.now)()});return file;
    }catch(error){
      if(!published){let removed=!created;if(created)try{await this.fs.unlink(temp);removed=true;}catch(cleanup){removed=absent(cleanup);}if(removed)await this.store.call({action:'media-cache-abort',name,owner}).catch(()=>{});}
      else this.fail(error);
      throw error;
    }
  }
}
