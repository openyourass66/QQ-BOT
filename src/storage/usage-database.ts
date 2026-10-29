import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {UsageDatabaseRequest} from './database-types.js';
import {insertModelRequest,finishModelRequest,modelRequestStatistics} from './request-ledger.js';
import {executeOperations,reserveOperation} from './operation-ledger.js';
import type {OperationDatabaseRequest} from './operation-types.js';

export function createUsageSchema(db:DatabaseSync){db.exec('CREATE TABLE daily_usage(date TEXT NOT NULL,key TEXT NOT NULL,used INTEGER NOT NULL CHECK(used>=0),PRIMARY KEY(date,key)) WITHOUT ROWID; CREATE TABLE quota_reservations(id TEXT PRIMARY KEY,date TEXT NOT NULL,hash TEXT NOT NULL,at REAL NOT NULL,quotas TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX quota_reservations_date ON quota_reservations(date); PRAGMA user_version=2;');}
export function executeUsage(request:UsageDatabaseRequest,context:{db:DatabaseSync;meta:(key:string)=>unknown;setMeta:(key:string,value:unknown)=>void;transaction:<T>(fn:()=>T)=>T;error:(code:string,message:string)=>Error}):unknown {
  const {db,meta,setMeta,transaction,error}=context;
  if(request.action.startsWith('usage-op-'))return executeOperations(request as OperationDatabaseRequest,context);
  if(request.action==='usage-finish-model')return transaction(()=>finishModelRequest(db,request.id,request.outcome,request.usage));
  if(request.action==='usage-recover-models')return transaction(()=>({recovered:Number(db.prepare("UPDATE model_requests SET state='unknown' WHERE state='reserved' AND finished=0").run().changes)}));
  if(!('date' in request))throw error('DATABASE_REQUEST_INVALID','未知额度操作。');const date=request.date;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw error('DATABASE_REQUEST_INVALID','额度日期格式无效。');
  const summary=()=>({date,counters:Object.fromEntries(db.prepare('SELECT key,used FROM daily_usage WHERE date=?').all(date).map(row=>[String(row.key),Number(row.used)]))});
  if(request.action==='usage-summary')return summary();
  if(request.action==='usage-request-stats')return modelRequestStatistics(db,date);
  return transaction(()=>{
    if(request.action==='usage-import'){
      if(meta('usage_imported'))throw error('DATABASE_REQUEST_INVALID','额度数据不能重复导入。');const counters=Object.entries(request.counters);
      if(counters.length+Number(db.prepare('SELECT COUNT(*) AS n FROM daily_usage').get()!.n)>20000||counters.some(([key,used])=>Buffer.byteLength(key)>4096||!Number.isSafeInteger(used)||used<0))throw error('DATABASE_REQUEST_INVALID','旧额度数据超出支持范围，原文件保留。');
      const insert=db.prepare('INSERT INTO daily_usage(date,key,used) VALUES(?,?,?)');for(const [key,used] of counters)insert.run(date,key,used);if(request.final!==false)setMeta('usage_imported',true);return {imported:counters.length,final:request.final!==false};
    }
    if(request.action!=='usage-consume')throw error('DATABASE_REQUEST_INVALID','未知额度预扣操作。');
    if(!meta('usage_imported'))throw error('DATABASE_NOT_INITIALIZED','额度迁移尚未完成。');
    if(!request.reservationId||request.reservationId.length>128||!Number.isFinite(request.at)||request.quotas.length>100)throw error('DATABASE_REQUEST_INVALID','额度预扣参数无效。');
    for(const q of request.quotas)if(!q||typeof q.key!=='string'||!q.key||q.key.length>512||typeof q.label!=='string'||q.label.length>2000||!Number.isSafeInteger(q.amount)||q.amount<=0||!Number.isSafeInteger(q.limit)||q.limit<0)throw error('DATABASE_REQUEST_INVALID','无效的额度参数。');
    if(request.request&&request.operation)throw error('DATABASE_REQUEST_INVALID','服务用量与外部动作不能共用预扣类型。');
    const hash=createHash('sha256').update(JSON.stringify({date,quotas:request.quotas,...(request.request?{request:request.request}:{}),...(request.operation?{operation:request.operation}:{})})).digest('hex'),previous=db.prepare('SELECT date,hash FROM quota_reservations WHERE id=?').get(request.reservationId);
    if(previous){if(previous.date!==date||previous.hash!==hash)throw error('DATABASE_RESERVATION_CONFLICT','同一额度预扣编号不能更换日期或内容。');return {...summary(),reused:true};}
    const last=String(meta('usage_pruned_date')??'');if(date>last){const cutoff=new Date(Date.parse(date+'T00:00:00Z')-31*86400000).toISOString().slice(0,10);db.prepare('DELETE FROM quota_reservations WHERE date<?').run(cutoff);db.prepare('DELETE FROM model_requests WHERE date<?').run(cutoff);db.prepare('DELETE FROM daily_usage WHERE date<?').run(cutoff);setMeta('usage_pruned_date',date);}
    if(Number(db.prepare('SELECT COUNT(*) AS n FROM quota_reservations').get()!.n)>=200000)throw error('DATABASE_STATE_LIMIT','额度预扣记录达到上限，请先整理历史。');
    for(const q of request.quotas){
      const used=Number(db.prepare('SELECT used FROM daily_usage WHERE date=? AND key=?').get(date,q.key)?.used??0);
      if(used>q.limit-q.amount)throw error('DATABASE_QUOTA_EXCEEDED',`${q.label}今日额度不足（已用 ${used}，上限 ${q.limit}）`);
      if(!used&&Number(db.prepare('SELECT COUNT(*) AS n FROM daily_usage WHERE date=?').get(date)!.n)>=20000&&!db.prepare('SELECT 1 FROM daily_usage WHERE date=? AND key=?').get(date,q.key))throw error('DATABASE_STATE_LIMIT','当日额度类别达到上限。');
      db.prepare('INSERT INTO daily_usage(date,key,used) VALUES(?,?,?) ON CONFLICT(date,key) DO UPDATE SET used=excluded.used').run(date,q.key,used+q.amount);
    }
    db.prepare('INSERT INTO quota_reservations(id,date,hash,at,quotas) VALUES(?,?,?,?,?)').run(request.reservationId,date,hash,request.at,JSON.stringify(request.quotas));
    if(request.request)insertModelRequest(db,request.request,request.reservationId,date,request.at);
    if(request.operation){if(!request.quotas.length)throw error('DATABASE_REQUEST_INVALID','外部动作缺少预扣额度。');reserveOperation(context,request.operation);}
    return {...summary(),reused:false};
  });
}
