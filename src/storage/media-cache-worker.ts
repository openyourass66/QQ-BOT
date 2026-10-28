import type {DatabaseSync} from 'node:sqlite';
import {MEDIA_CACHE_MAX_FILES,safeMediaName,mediaCacheError,type MediaCacheRequest,type StoredMediaCacheEntry} from './media-cache-types.js';

type Context={db:DatabaseSync;meta:(key:string)=>unknown;setMeta:(key:string,value:unknown)=>void;transaction:<T>(fn:()=>T)=>T};
export function createMediaCacheSchema(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS media_cache_files(name TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime REAL NOT NULL,last_used REAL NOT NULL,owned INTEGER NOT NULL,state TEXT NOT NULL,owner TEXT NOT NULL,seen TEXT NOT NULL,file_tag TEXT NOT NULL DEFAULT '') WITHOUT ROWID;CREATE INDEX IF NOT EXISTS media_cache_state ON media_cache_files(state,last_used);PRAGMA user_version=8;");}
const validOwner=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=128;
function entry(row:Record<string,unknown>):StoredMediaCacheEntry{return {name:String(row.name),size:Number(row.size),mtime:Number(row.mtime),lastUsed:Number(row.last_used),owned:!!row.owned,state:row.state as StoredMediaCacheEntry['state'],owner:String(row.owner),seen:String(row.seen),fileTag:String(row.file_tag)};}
export function executeMediaCache(request:MediaCacheRequest,c:Context):unknown{
  const {db,meta,setMeta,transaction}=c,stats=()=>({files:Number(meta('media_cache_files')??0),bytes:Number(meta('media_cache_bytes')??0)});
  if(request.action==='media-cache-read'){if(!safeMediaName(request.name))throw mediaCacheError('INVALID','媒体文件名无效');const row=db.prepare('SELECT * FROM media_cache_files WHERE name=?').get(request.name);return row?entry(row):null;}
  if(request.action==='media-cache-statistics')return stats();
  return transaction(()=>{
    if(request.action==='media-cache-recover'){db.exec("UPDATE media_cache_files SET state='stale' WHERE state='reserved';");setMeta('media_cache_scan',null);setMeta('media_cache_ready',false);return {ok:true};}
    if(request.action==='media-cache-scan-start'){
      if(!validOwner(request.owner)||typeof request.root!=='string'||!request.root||request.root.length>32768)throw mediaCacheError('INVALID','媒体索引位置或持有者无效');
      if(meta('media_cache_scan')||db.prepare("SELECT 1 FROM media_cache_files WHERE state='reserved' LIMIT 1").get())throw mediaCacheError('BUSY','媒体保存或索引正在处理，请稍后再试');
      if(meta('media_cache_root')!==request.root){db.exec('DELETE FROM media_cache_files');setMeta('media_cache_root',request.root);setMeta('media_cache_files',0);setMeta('media_cache_bytes',0);}
      setMeta('media_cache_scan',request.owner);setMeta('media_cache_ready',false);
      const stale=db.prepare("SELECT name,owner,file_tag FROM media_cache_files WHERE state='stale' LIMIT 64").all().map(row=>({name:String(row.name),owner:String(row.owner),fileTag:String(row.file_tag)}));return {stale};
    }
    if(request.action==='media-cache-scan-batch'){
      if(meta('media_cache_scan')!==request.owner||request.entries.length>128)throw mediaCacheError('INVALID','媒体索引批次无效');
      for(const file of request.entries){if(!safeMediaName(file.name)||!Number.isSafeInteger(file.size)||file.size<0||!Number.isFinite(file.mtime)||typeof file.owned!=='boolean')throw mediaCacheError('INVALID','媒体文件统计无效');
        db.prepare("INSERT INTO media_cache_files(name,size,mtime,last_used,owned,state,owner,seen) VALUES(?,?,?,?,?,'complete','',?) ON CONFLICT(name) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,last_used=MAX(media_cache_files.last_used,excluded.last_used),owned=excluded.owned,state='complete',owner='',seen=excluded.seen,file_tag=''").run(file.name,file.size,file.mtime,file.mtime,file.owned?1:0,request.owner);
      }
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM media_cache_files WHERE seen=?').get(request.owner)!.n)>MEDIA_CACHE_MAX_FILES)throw mediaCacheError('LIMIT','媒体目录文件数超过支持上限，请先整理');return {ok:true};
    }
    if(request.action==='media-cache-scan-complete'){
      if(meta('media_cache_scan')!==request.owner)throw mediaCacheError('INVALID','媒体索引持有者已变化');db.prepare('DELETE FROM media_cache_files WHERE seen<>?').run(request.owner);
      const row=db.prepare('SELECT COUNT(*) AS files,COALESCE(SUM(size),0) AS bytes FROM media_cache_files').get()!;setMeta('media_cache_files',Number(row.files));setMeta('media_cache_bytes',Number(row.bytes));setMeta('media_cache_scan',null);setMeta('media_cache_ready',true);return stats();
    }
    if(request.action==='media-cache-scan-abort'){if(meta('media_cache_scan')===request.owner)setMeta('media_cache_scan',null);return {ok:true};}
    if('name'in request&&!safeMediaName(request.name))throw mediaCacheError('INVALID','媒体文件名无效');
    if(request.action==='media-cache-reserve'){
      if(!meta('media_cache_ready')||meta('media_cache_scan'))throw mediaCacheError('BUSY','媒体索引尚未完成，请稍后再试');
      if(!validOwner(request.owner)||!Number.isSafeInteger(request.size)||request.size<0||!Number.isSafeInteger(request.limit)||request.limit<0)throw mediaCacheError('INVALID','媒体保存大小无效');
      if(db.prepare('SELECT 1 FROM media_cache_files WHERE name=?').get(request.name))throw mediaCacheError('BUSY','同名媒体仍在保存或等待核对');const current=stats();
      if(current.files>=MEDIA_CACHE_MAX_FILES||current.bytes+request.size>request.limit)throw mediaCacheError('QUOTA','媒体库空间额度不足，请清理不再使用的媒体或调整 BOT_MEDIA_MAX_BYTES');
      db.prepare("INSERT INTO media_cache_files(name,size,mtime,last_used,owned,state,owner,seen) VALUES(?,?,0,0,1,'reserved',?,'')").run(request.name,request.size,request.owner);setMeta('media_cache_files',current.files+1);setMeta('media_cache_bytes',current.bytes+request.size);return stats();
    }
    if(request.action==='media-cache-stage'){if(typeof request.fileTag!=='string'||!/^\d+:\d+$/.test(request.fileTag)||request.fileTag.length>128)throw mediaCacheError('INVALID','媒体临时文件标识无效');const result=db.prepare("UPDATE media_cache_files SET file_tag=? WHERE name=? AND state='reserved' AND owner=? AND file_tag=''").run(request.fileTag,request.name,request.owner);if(!result.changes)throw mediaCacheError('INVALID','媒体临时文件凭证失效');return {ok:true};}
    if(request.action==='media-cache-complete'){
      if(!Number.isFinite(request.mtime)||!Number.isFinite(request.at))throw mediaCacheError('INVALID','媒体完成时间无效');const result=db.prepare("UPDATE media_cache_files SET state='complete',owner='',file_tag='',mtime=?,last_used=? WHERE name=? AND state='reserved' AND owner=? AND file_tag<>''").run(request.mtime,request.at,request.name,request.owner);if(!result.changes)throw mediaCacheError('INVALID','媒体保存凭证已失效');return stats();
    }
    if(request.action==='media-cache-touch'){if(!Number.isFinite(request.at))throw mediaCacheError('INVALID','媒体访问时间无效');db.prepare("UPDATE media_cache_files SET last_used=? WHERE name=? AND state='complete'").run(request.at,request.name);return {ok:true};}
    if(request.action==='media-cache-abort'||request.action==='media-cache-forget'){
      const row=db.prepare('SELECT size,state,owner FROM media_cache_files WHERE name=?').get(request.name);
      if(row&&(request.action==='media-cache-forget'?row.state==='complete':row.state==='reserved'&&row.owner===request.owner)){db.prepare('DELETE FROM media_cache_files WHERE name=?').run(request.name);const current=stats();setMeta('media_cache_files',current.files-1);setMeta('media_cache_bytes',current.bytes-Number(row.size));}return stats();
    }
    throw mediaCacheError('INVALID','媒体索引操作无效');
  });
}
