import {lstat,realpath} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {dataPaths,mutableDataResources} from '../core/data-paths.js';
import {acquireDataResources} from '../core/resource-lock.js';
import {DatabaseClient} from '../storage/database-client.js';
import {verifyMigrationSource} from '../storage/social-migration.js';
import type {MediaCacheStore,MediaCacheCursor,StoredMediaCacheEntry} from '../storage/media-cache-types.js';
import {ownedMediaName} from '../storage/media-cache-types.js';
import type {MediaReferenceQuery} from '../storage/media-reference-types.js';
import {MediaCache,MEDIA_WRITE_LIMITS} from './media-cache.js';

export type MediaRemoval={status:'deleted'|'missing'|'kept';reason?:string};
export type MediaCleanupOptions={
  retentionDays?:number;limit?:number;budgetMs?:number;dryRun?:boolean;signal?:AbortSignal;
  remove?:(root:string,entry:StoredMediaCacheEntry,cutoff:number,authorize:()=>Promise<boolean>,signal:AbortSignal)=>Promise<MediaRemoval>;
  onProgress?:(progress:{examined:number;deleted:number;protected:number})=>void;
  now?:()=>number;
};
export type MediaCleanupResult={dryRun:boolean;examined:number;eligible:number;protected:number;kept:number;deleted:number;missing:number;bytes:number;complete:boolean;reason:'complete'|'limit'|'time-budget';};
const invalid=(message:string)=>Object.assign(new Error(message),{code:'MEDIA_CLEANUP_INVALID'});

/** Offline maintenance owns every shared resource until all native file handles and Workers close. */
export async function cleanupMedia(paths:ReturnType<typeof dataPaths>,options:MediaCleanupOptions={}):Promise<MediaCleanupResult>{
  const days=options.retentionDays??30,limit=options.limit??100,budget=options.budgetMs??30000;
  if(!Number.isSafeInteger(days)||days<1||days>3650||!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(budget)||budget<1||budget>300000)throw invalid('保留天数须为 1–3650，单次清理上限须为 1–1000，时间预算须为 1–300000 毫秒');
  if(!options.dryRun&&!options.remove)throw invalid('缺少经过验证的本机文件清理组件');
  const now=(options.now??Date.now)(),cutoff=now-days*86400000;if(!Number.isFinite(cutoff)||cutoff<=0)throw invalid('媒体清理时间无效');
  const signal=options.signal??new AbortController().signal;signal.throwIfAborted();
  const deadline=performance.now()+budget,result:MediaCleanupResult={dryRun:!!options.dryRun,examined:0,eligible:0,protected:0,kept:0,deleted:0,missing:0,bytes:0,complete:false,reason:'time-budget'};
  const budgetEnded=new Error('媒体清理时间预算已用尽'),check=()=>{signal.throwIfAborted();if(performance.now()>=deadline)throw budgetEnded;};
  const lease=await acquireDataResources(mutableDataResources(paths),signal),clients:DatabaseClient[]=[];
  let cache:MediaCache|undefined;
  try{
    // Refuse absent or unrecognized databases instead of constructing an empty reference universe.
    for(const [path,kind] of [[paths.social,'social'],[paths.usage,'daily-usage']]){
      signal.throwIfAborted();const info=await lstat(path+'.sqlite').catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
      if(!info?.isFile()||info.isSymbolicLink()||info.nlink!==1)throw invalid('清理需要已经迁移且路径有效的社交和额度数据库，请先完成实例初始化');
      const client=new DatabaseClient(path+'.sqlite');clients.push(client);
      const metadata=await client.call({action:'metadata'});
      if(!metadata.initialized||metadata.source?.kind!==kind||kind==='daily-usage'&&!metadata.usageInitialized)throw invalid('媒体引用数据库类型或初始化状态无效');
      await verifyMigrationSource(path,metadata.source);
      const integrity=await client.call({action:'integrity'});if(integrity.check.join(',')!=='ok')throw invalid('媒体引用数据库校验未通过，请保留资料并先修复');
    }
    // Drain both backfills before considering any ordinary file for deletion.
    for(const client of clients){for(;;){signal.throwIfAborted();if(performance.now()>=deadline)return result;const status=await client.call({action:'media-refs-backfill'});if(status.ready)break;await setImmediate();}}
    const rootInfo=await lstat(paths.media).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
    if(!rootInfo){result.complete=true;result.reason='complete';return result;}
    if(!rootInfo.isDirectory()&&!rootInfo.isSymbolicLink())throw invalid('媒体库位置不是可用目录');
    const root=await realpath(paths.media),usage=clients[1],index:MediaCacheStore={call:request=>usage.call(request)};
    const recovery=await index.call<{unsettled:number}>({action:'media-cache-recover'});
    if(recovery.unsettled)throw invalid('媒体保存存在未确认记录，请先正常启动并停止实例完成保存恢复，再进行清理；文件已保留');
    cache=new MediaCache(root,index,{signal,preserveTemporary:true,check});await cache.reconcile();
    const protectedNames=async(names:string[])=>{
      const protectedSet=new Set<string>();
      for(const client of clients){const found=await client.call<MediaReferenceQuery>({action:'media-refs-query',names});if(!found.ready)throw invalid('媒体引用回填尚未完成，已停止清理');for(const name of found.names)protectedSet.add(name);}
      return protectedSet;
    };
    let after:MediaCacheCursor|undefined;
    for(;;){
      signal.throwIfAborted();if(performance.now()>=deadline)return result;
      const batch=await index.call<StoredMediaCacheEntry[]>({action:'media-cache-candidates',cutoff,limit:64,after});
      if(!batch.length){result.complete=true;result.reason='complete';return result;}
      const candidates=batch.filter(entry=>ownedMediaName(entry.name)),protectedSet=await protectedNames(candidates.map(entry=>entry.name));
      for(const entry of batch){
        signal.throwIfAborted();if(performance.now()>=deadline)return result;
        if(result.eligible>=limit){result.reason='limit';return result;}
        after={lastUsed:entry.lastUsed,name:entry.name};result.examined++;
        if(!ownedMediaName(entry.name)||entry.size>MEDIA_WRITE_LIMITS.file){result.kept++;continue;}
        if(protectedSet.has(entry.name.toLowerCase())){result.protected++;continue;}
        result.eligible++;
        if(options.dryRun)continue;
        const removed=await options.remove!(root,entry,cutoff,async()=>{
          signal.throwIfAborted();if(performance.now()>=deadline)return false;
          return !(await protectedNames([entry.name])).has(entry.name.toLowerCase());
        },signal);
        // A lost native reply is never retried. Reconciliation repairs counts on the next run.
        if(removed.status==='deleted'||removed.status==='missing'){
          await index.call({action:'media-cache-forget',name:entry.name});
          if(removed.status==='deleted'){result.deleted++;result.bytes+=entry.size;}else result.missing++;
        }else if(removed.status==='kept')result.kept++;
        else throw invalid('文件清理组件返回了未知状态，已停止后续清理');
        options.onProgress?.({examined:result.examined,deleted:result.deleted,protected:result.protected});await setImmediate();
      }
    }
  }catch(error){if(error===budgetEnded)return result;throw error;}finally{
    // Do not release a shared lock while a Worker or a native deletion may still be in flight.
    try{await cache?.flush();}finally{try{const closed=await Promise.allSettled(clients.map(client=>client.close()));const failed=closed.find(item=>item.status==='rejected');if(failed?.status==='rejected')throw failed.reason;}finally{lease.release();}}
  }
}
