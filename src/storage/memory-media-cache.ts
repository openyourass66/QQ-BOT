import {MEDIA_CACHE_MAX_FILES,safeMediaName,mediaCacheError,type MediaCacheRequest,type MediaCacheStore,type StoredMediaCacheEntry} from './media-cache-types.js';

/** 无持久文件的参考索引，生产桥接使用额度 Worker 中的实现。 */
export class MemoryMediaCacheStore implements MediaCacheStore {
  private rows=new Map<string,StoredMediaCacheEntry>();
  private root='';private scan='';private ready=false;private used=0;
  async call<T=unknown>(r:MediaCacheRequest):Promise<T>{return this.execute(r) as T;}
  private stats(){return {files:this.rows.size,bytes:this.used};}
  private put(row:StoredMediaCacheEntry){this.used+=row.size-(this.rows.get(row.name)?.size??0);this.rows.set(row.name,row);}
  private remove(name:string){this.used-=this.rows.get(name)?.size??0;this.rows.delete(name);}
  private execute(r:MediaCacheRequest):unknown{
    if(r.action==='media-cache-read'){if(!safeMediaName(r.name))throw mediaCacheError('INVALID','媒体文件名无效');return structuredClone(this.rows.get(r.name)??null);}
    if(r.action==='media-cache-statistics')return this.stats();
    if(r.action==='media-cache-candidates'){
      if(!Number.isFinite(r.cutoff)||!Number.isSafeInteger(r.limit)||r.limit<1||r.limit>64||r.after&&(!Number.isFinite(r.after.lastUsed)||!safeMediaName(r.after.name)))throw mediaCacheError('INVALID','媒体清理查询范围无效');
      if(!this.ready||this.scan)throw mediaCacheError('BUSY','媒体索引尚未完成');
      return structuredClone([...this.rows.values()].filter(row=>row.state==='complete'&&row.owned&&row.lastUsed<=r.cutoff&&row.mtime<=r.cutoff&&(!r.after||row.lastUsed>r.after.lastUsed||row.lastUsed===r.after.lastUsed&&row.name>r.after.name)).sort((a,b)=>a.lastUsed-b.lastUsed||(a.name<b.name?-1:a.name>b.name?1:0)).slice(0,r.limit));
    }
    if(r.action==='media-cache-recover'){for(const row of this.rows.values())if(row.state==='reserved')row.state='stale';this.scan='';this.ready=false;return {ok:true,unsettled:[...this.rows.values()].filter(row=>row.state==='stale').length};}
    if(r.action==='media-cache-scan-start'){if(typeof r.owner!=='string'||!r.owner||r.owner.length>128||typeof r.root!=='string'||!r.root||r.root.length>32768)throw mediaCacheError('INVALID','媒体索引持有者无效');if(this.scan||[...this.rows.values()].some(row=>row.state==='reserved'))throw mediaCacheError('BUSY','媒体正在处理');if(this.root!==r.root){this.rows.clear();this.used=0;this.root=r.root;}this.scan=r.owner;this.ready=false;return {stale:[...this.rows.values()].filter(row=>row.state==='stale').map(({name,owner,fileTag})=>({name,owner,fileTag}))};}
    if(r.action==='media-cache-scan-batch'){
      if(this.scan!==r.owner||r.entries.length>128)throw mediaCacheError('INVALID','媒体索引批次无效');
      const seen=new Set([...this.rows.values()].filter(row=>row.seen===r.owner).map(row=>row.name));
      for(const row of r.entries){if(!safeMediaName(row.name)||!Number.isSafeInteger(row.size)||row.size<0||!Number.isFinite(row.mtime)||typeof row.owned!=='boolean')throw mediaCacheError('INVALID','媒体文件统计无效');seen.add(row.name);}
      if(seen.size>MEDIA_CACHE_MAX_FILES)throw mediaCacheError('LIMIT','媒体文件数超限');
      for(const row of r.entries)this.put({...row,lastUsed:Math.max(row.mtime,this.rows.get(row.name)?.lastUsed??0),state:'complete',owner:'',seen:r.owner,fileTag:''});return {ok:true};
    }
    if(r.action==='media-cache-scan-complete'){if(this.scan!==r.owner)throw mediaCacheError('INVALID','媒体索引持有者已变化');for(const [name,row]of this.rows)if(row.seen!==r.owner)this.remove(name);this.scan='';this.ready=true;return this.stats();}
    if(r.action==='media-cache-scan-abort'){if(this.scan===r.owner)this.scan='';return {ok:true};}
    if(!safeMediaName(r.name))throw mediaCacheError('INVALID','媒体文件名无效');const row=this.rows.get(r.name);
    if(r.action==='media-cache-reserve'){if(!this.ready||this.scan||row)throw mediaCacheError('BUSY','媒体索引或同名文件正在处理');if(typeof r.owner!=='string'||!r.owner||r.owner.length>128||!Number.isSafeInteger(r.size)||r.size<0||!Number.isSafeInteger(r.limit)||r.limit<0)throw mediaCacheError('INVALID','媒体保存大小无效');if(this.rows.size>=MEDIA_CACHE_MAX_FILES||this.used+r.size>r.limit)throw mediaCacheError('QUOTA','媒体库空间额度不足');this.put({name:r.name,size:r.size,mtime:0,lastUsed:0,owned:true,state:'reserved',owner:r.owner,seen:'',fileTag:''});return this.stats();}
    if(r.action==='media-cache-stage'){if(!row||row.state!=='reserved'||row.owner!==r.owner||row.fileTag||!/^\d+:\d+$/.test(r.fileTag)||r.fileTag.length>128)throw mediaCacheError('INVALID','媒体临时文件凭证失效');row.fileTag=r.fileTag;return {ok:true};}
    if(r.action==='media-cache-complete'){if(!row||row.state!=='reserved'||row.owner!==r.owner||!row.fileTag||!Number.isFinite(r.mtime)||!Number.isFinite(r.at))throw mediaCacheError('INVALID','媒体保存凭证失效');Object.assign(row,{mtime:r.mtime,lastUsed:r.at,state:'complete',owner:'',fileTag:''});return this.stats();}
    if(r.action==='media-cache-touch'){if(!Number.isFinite(r.at))throw mediaCacheError('INVALID','媒体访问时间无效');if(row?.state==='complete')row.lastUsed=r.at;return {ok:true};}
    if(r.action==='media-cache-abort'||r.action==='media-cache-forget'){if(row&&(r.action==='media-cache-forget'?row.state==='complete':row.state==='reserved'&&row.owner===r.owner))this.remove(r.name);return this.stats();}
    throw mediaCacheError('INVALID','媒体索引操作无效');
  }
}
