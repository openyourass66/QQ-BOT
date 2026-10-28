import type {DatabaseSync} from 'node:sqlite';
import type {ModelRequestRecord,ReportedUsage} from './database-types.js';

export function createRequestSchema(db:DatabaseSync){db.exec('CREATE TABLE model_requests(id TEXT PRIMARY KEY,date TEXT NOT NULL,at REAL NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,finished INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL,usage TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX model_requests_date ON model_requests(date,at DESC);PRAGMA user_version=3;');}
export function insertModelRequest(db:DatabaseSync,record:ModelRequestRecord,id:string,date:string,at:number){
  if(typeof record.background!=='boolean')throw Object.assign(new Error('模型请求缺少可信任务来源。'),{code:'DATABASE_REQUEST_INVALID'});
  if(record.id!==id||!['conversation','compaction','vision','transcription','speech','learning','search','fetch'].includes(record.kind)||!record.turn||record.turn.length>128||[record.chat,record.user,record.provider,record.model].some(value=>typeof value!=='string'||value.length>256)||!Number.isSafeInteger(record.maxOutputTokens)||record.maxOutputTokens<0||record.maxOutputTokens>65536)throw Object.assign(new Error('模型请求记录参数无效。'),{code:'DATABASE_REQUEST_INVALID'});
  db.prepare('INSERT INTO model_requests(id,date,at,kind,state,metadata,usage) VALUES(?,?,?,?,?,?,?)').run(id,date,at,record.kind,'reserved',JSON.stringify(record),JSON.stringify({inputTokens:null,outputTokens:null}));
}
export function finishModelRequest(db:DatabaseSync,id:string,outcome:string,usage:ReportedUsage){
  if(!['completed','failed','unknown'].includes(outcome))throw Object.assign(new Error('模型请求状态无效。'),{code:'DATABASE_REQUEST_INVALID'});
  const normalized:ReportedUsage={inputTokens:usage.inputTokens??null,outputTokens:usage.outputTokens??null};for(const key of ['cacheReadTokens','cacheWriteTokens','totalTokens'] as const)if(usage[key]!==undefined)normalized[key]=usage[key];
  if(Object.values(normalized).some(value=>value!==null&&(!Number.isSafeInteger(value)||value<0||value>1000000000)))throw Object.assign(new Error('服务上报用量格式无效，未使用估计值替代。'),{code:'DATABASE_REQUEST_INVALID'});
  const row=db.prepare('SELECT state,finished,usage FROM model_requests WHERE id=?').get(id);if(!row)throw Object.assign(new Error('模型请求记录不存在。'),{code:'DATABASE_REQUEST_INVALID'});
  const encoded=JSON.stringify(normalized);if(row.finished){if(row.state!==outcome||row.usage!==encoded)throw Object.assign(new Error('已完成的模型用量不能被其他结果覆盖。'),{code:'DATABASE_RESERVATION_CONFLICT'});return {reused:true};}
  db.prepare('UPDATE model_requests SET state=?,finished=1,usage=? WHERE id=?').run(outcome,encoded,id);return {reused:false};
}
export function modelRequestStatistics(db:DatabaseSync,date:string){
  let requests=0,usageKnown=0,inputTokens=0,outputTokens=0,unknownResults=0,background=0;const kinds:Record<string,number>={};
  for(const row of db.prepare('SELECT state,usage,metadata,kind FROM model_requests WHERE date=?').iterate(date)){requests++;const usage=JSON.parse(String(row.usage)) as ReportedUsage,metadata=JSON.parse(String(row.metadata)) as ModelRequestRecord;kinds[String(row.kind)]=(kinds[String(row.kind)]??0)+1;if(metadata.background)background++;if(usage.inputTokens!==null&&usage.outputTokens!==null){usageKnown++;inputTokens+=usage.inputTokens;outputTokens+=usage.outputTokens;}if(row.state==='reserved'||row.state==='unknown')unknownResults++;}
  return {date,requests,background,foreground:requests-background,kinds,usageKnown,usageUnknown:requests-usageKnown,knownInputTokens:inputTokens,knownOutputTokens:outputTokens,unknownResults};
}
