import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {openSync,writeSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {rawDataFromRows} from './entity-layout.js';
import {entityTables,DATABASE_LIMITS,type DatabaseRequest,type UsageDatabaseRequest,type EntityRow,type EntityChange} from './database-types.js';
import {createUsageSchema,executeUsage} from './usage-database.js';
import type {MessageQuery,MessageRef} from './social-repository.js';
import type {StoredMessage} from '../qq/social-store.js';

const port=parentPort!;let db:DatabaseSync;
const error=(code:string,message:string)=>Object.assign(new Error(message),{code});
const tableName=(name:string)=>{if(!entityTables.includes(name as never))throw error('DATABASE_REQUEST_INVALID','数据库操作参数无效');return 'entity_'+name;};
function transaction<T>(fn:()=>T):T {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(failure){db.exec('ROLLBACK');throw failure;}}
function readSnapshot<T>(fn:()=>T):T {db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(failure){db.exec('ROLLBACK');throw failure;}}
function writeAll(file:number,text:string){const bytes=Buffer.from(text);let offset=0;while(offset<bytes.length){const written=writeSync(file,bytes,offset,bytes.length-offset);if(!written)throw new Error('导出写入中断');offset+=written;}}
function meta(key:string):unknown {const row=db.prepare('SELECT value FROM runtime_meta WHERE key=?').get(key);return row?JSON.parse(String(row.value)):undefined;}
function setMeta(key:string,value:unknown){db.prepare('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
const revision=()=>Number(meta('revision')??0);
function checkRevision(expected:number){if(!Number.isSafeInteger(expected)||expected!==revision())throw error('DATABASE_REVISION_CONFLICT','数据库已被其他写入者修改，请停止重复实例后重新启动。');}
function changeEntity(row:EntityChange,insert=false){
  const table=tableName(row.table);
  if(typeof row.key!=='string'||row.key.length>1024)throw error('DATABASE_REQUEST_INVALID','数据库记录编号无效');
  const previous=db.prepare(`SELECT length(CAST(payload AS BLOB)) AS size FROM ${table} WHERE key=?`).get(row.key),overhead=Buffer.byteLength(row.key)+row.table.length+128;
  if(row.value===undefined){db.prepare(`DELETE FROM ${table} WHERE key=?`).run(row.key);if(previous)setMeta('metadata_bytes',Number(meta('metadata_bytes')??0)-Number(previous.size)-overhead);return;}
  const payload=JSON.stringify(row.value),size=Number(meta('metadata_bytes')??0)+Buffer.byteLength(payload)+overhead-(previous?Number(previous.size)+overhead:0);
  if(size>DATABASE_LIMITS.responseBytes-8192)throw error('DATABASE_STATE_LIMIT','业务记录已达到容量上限，请在数据维护中整理历史；本次修改未写入。');
  const value=row.value as Record<string,unknown>;
  const sql=`INSERT INTO ${table}(key,ordinal,chat,at,state,due,retry_at,payload) VALUES(?,?,?,?,?,?,?,?)`+(insert?'':' ON CONFLICT(key) DO UPDATE SET ordinal=excluded.ordinal,chat=excluded.chat,at=excluded.at,state=excluded.state,due=excluded.due,retry_at=excluded.retry_at,payload=excluded.payload');
  db.prepare(sql).run(row.key,row.ordinal??0,String(value?.chat??''),Number(value?.at??0),String(value?.state??''),Number(value?.due??0),Number(value?.retryAt??0),payload);setMeta('metadata_bytes',size);
}
function putMessage(m:StoredMessage,insertOnly=false,strict=false){
  const exists=!insertOnly&&!strict&&db.prepare('SELECT 1 FROM messages WHERE chat=? AND id=?').get(m.chat,m.id);
  const result=db.prepare('INSERT INTO messages(chat,id,user,name,at,text,self,recalled,payload) VALUES(?,?,?,?,?,?,?,?,?)'+(strict?'':insertOnly?' ON CONFLICT(chat,id) DO NOTHING':' ON CONFLICT(chat,id) DO UPDATE SET user=excluded.user,name=excluded.name,at=excluded.at,text=excluded.text,self=excluded.self,recalled=excluded.recalled,payload=excluded.payload')).run(m.chat,m.id,String(m.user),m.name,m.at,m.text,m.self?1:0,m.recalled?1:0,JSON.stringify(m));
  if(result.changes&&!exists)setMeta('messages_count',Number(meta('messages_count')??0)+1);return result;
}
function deleteMessages(sql:string,...args:SQLInputValue[]){const removed=Number(db.prepare(sql).run(...args).changes);if(removed)setMeta('messages_count',Number(meta('messages_count')??0)-removed);}
function decodedRows(rows:Iterable<Record<string,unknown>>):any[]{const result:unknown[]=[];let bytes=0;for(const row of rows){const payload=String(row.payload);bytes+=Buffer.byteLength(payload);if(bytes>DATABASE_LIMITS.responseBytes-1024)throw error('DATABASE_RESPONSE_TOO_LARGE','查询结果过大，请缩小查询范围或分页读取。');result.push(JSON.parse(payload));}return result;}
function messageQuery(q:MessageQuery){
  const clauses:string[]=[],args:SQLInputValue[]=[];
  if(q.chat!==undefined){clauses.push('chat=?');args.push(q.chat);}
  if(q.ids){if(q.ids.length>20000)throw error('DATABASE_REQUEST_INVALID','单次消息编号过多');if(!q.ids.length)clauses.push('0');else{clauses.push(`id IN (${q.ids.map(()=>'?').join(',')})`);args.push(...q.ids);}}
  if(q.after!==undefined){clauses.push('at>=?');args.push(q.after);}
  if(q.incomingOnly)clauses.push('self=0 AND recalled=0');
  if(q.excludeUsers?.length){clauses.push(`user NOT IN (${q.excludeUsers.map(()=>'?').join(',')})`);args.push(...q.excludeUsers);}
  if(q.query){clauses.push("instr(lower(name||' '||text||' '||chat),lower(?))>0");args.push(q.query);}
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'',limit=Math.min(20000,Math.max(1,Math.floor(q.limit??100))),offset=Math.max(0,Math.floor(q.offset??0));
  const total=Number(db.prepare('SELECT COUNT(*) AS total FROM messages'+where).get(...args)!.total);
  const order=q.ascending?'ASC':'DESC';
  const rows=decodedRows(db.prepare(`SELECT payload FROM messages${where} ORDER BY at ${order},id ${order} LIMIT ? OFFSET ?`).iterate(...args,limit,offset));
  return {rows,total};
}
function lookup(refs:MessageRef[],evidenceOnly=false){
  if(refs.length>20000)throw error('DATABASE_REQUEST_INVALID','单次消息编号过多');const found=new Map<string,StoredMessage>(),statement=db.prepare(`SELECT ${evidenceOnly?'chat,id,user,at,self,recalled':'payload'} FROM messages WHERE chat=? AND id=?`);
  let bytes=0;for(const ref of refs){const key=`${ref.chat}/${ref.id}`;if(found.has(key))continue;const row=statement.get(ref.chat,ref.id);if(row){const message=evidenceOnly?{chat:String(row.chat),id:Number(row.id),user:Number(row.user),name:'',at:Number(row.at),text:'',segments:[],self:!!row.self,recalled:!!row.recalled}:JSON.parse(String(row.payload));bytes+=Buffer.byteLength(JSON.stringify(message));if(bytes>DATABASE_LIMITS.responseBytes-1024)throw error('DATABASE_RESPONSE_TOO_LARGE','消息查询结果过大，请分批读取。');found.set(key,message);}}return [...found.values()];
}
function execute(request:DatabaseRequest):unknown {
  if(!meta('initialized')&&!['metadata','import','complete-import','integrity','fingerprint','close'].includes(request.action))throw error('DATABASE_NOT_INITIALIZED','数据库迁移尚未完成，不能开放业务。');
  if(request.action.startsWith('usage-'))return executeUsage(request as UsageDatabaseRequest,{db,meta,setMeta,transaction,error});
  switch(request.action){
    case 'metadata':{
      const rows:EntityRow[]=[];let bytes=0;
      for(const table of entityTables)for(const row of db.prepare(`SELECT key,ordinal,payload FROM ${tableName(table)} ORDER BY ordinal,key`).iterate()){bytes+=Buffer.byteLength(String(row.payload))+128;if(bytes>DATABASE_LIMITS.responseBytes-1024)throw error('DATABASE_RESPONSE_TOO_LARGE','业务状态超出支持容量，请保留数据并使用维护工具整理。');rows.push({table,key:String(row.key),ordinal:Number(row.ordinal),value:JSON.parse(String(row.payload))});}
      return {revision:revision(),initialized:!!meta('initialized'),usageInitialized:!!meta('usage_imported'),source:meta('source'),rows};
    }
    case 'import':
      if(meta('initialized'))throw error('DATABASE_REQUEST_INVALID','已使用的数据库不能重复导入。');
      return transaction(()=>{for(const row of request.rows){if(row.table==='messages')putMessage(row.value,true,true);else changeEntity(row,true);}return {imported:request.rows.length};});
    case 'complete-import':if(meta('initialized'))throw error('DATABASE_REQUEST_INVALID','数据库已经完成导入。');return transaction(()=>{setMeta('source',request.source);setMeta('initialized',true);return {revision:revision()};});
    case 'mutate':return transaction(()=>{checkRevision(request.expectedRevision);for(const row of request.changes)changeEntity(row);for(const m of request.messages??[])putMessage(m);const next=revision()+1;setMeta('revision',next);return {revision:next};});
    case 'add-message':return transaction(()=>{
      checkRevision(request.expectedRevision);const m=request.entry;if(!putMessage(m,true).changes)return {revision:revision(),inserted:false,contacts:[],removedContacts:[]};
      deleteMessages('DELETE FROM messages WHERE at<?',request.cutoff);
      deleteMessages('DELETE FROM messages WHERE chat=? AND id IN (SELECT id FROM messages WHERE chat=? ORDER BY at DESC,id DESC LIMIT -1 OFFSET ?)',m.chat,m.chat,request.perChat);
      const excess=Number(meta('messages_count')??0)-50000;
      if(excess>0)deleteMessages('DELETE FROM messages WHERE (chat,id) IN (SELECT chat,id FROM messages ORDER BY at ASC,id ASC LIMIT ?)',excess);
      const row=db.prepare('SELECT ordinal,payload FROM entity_contacts WHERE key=?').get(m.chat),contact=row?JSON.parse(String(row.payload)):{chat:m.chat,name:m.chat.startsWith('private:')?m.name:m.chat,at:m.at};contact.at=Math.max(contact.at,m.at);
      const ordinal=row?Number(row.ordinal):Number(db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS next FROM entity_contacts').get()!.next);
      const changed:EntityRow={table:'contacts',key:m.chat,ordinal,value:contact};changeEntity(changed);
      const removed=db.prepare('SELECT key FROM entity_contacts ORDER BY ordinal DESC LIMIT -1 OFFSET 5000').all().map(row=>String(row.key));for(const key of removed)changeEntity({table:'contacts',key});
      const next=revision()+1;setMeta('revision',next);return {revision:next,inserted:true,contacts:[changed],removedContacts:removed};
    });
    case 'query-messages':return messageQuery(request.query);
    case 'lookup-messages':return lookup(request.refs,request.evidenceOnly);
    case 'latest-incoming':{
      const excluded=request.excludeUsers,where=excluded.length?` AND user NOT IN (${excluded.map(()=>'?').join(',')})`:'';
      return decodedRows(db.prepare(`WITH ranked AS (SELECT chat,id,ROW_NUMBER() OVER(PARTITION BY chat ORDER BY at DESC,id DESC) AS rank FROM messages WHERE self=0 AND recalled=0${where}) SELECT m.payload FROM ranked r JOIN messages m ON m.chat=r.chat AND m.id=r.id WHERE rank=1`).iterate(...excluded));
    }
    case 'integrity':return {check:db.prepare('PRAGMA quick_check').all().map(row=>Object.values(row)[0]),counts:Object.fromEntries(['messages',...entityTables.map(tableName)].map(table=>[table,Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]))};
    case 'fingerprint':{
      const hash=createHash('sha256');for(const table of entityTables)for(const row of db.prepare(`SELECT key,ordinal,payload FROM ${tableName(table)} ORDER BY key`).iterate())hash.update(JSON.stringify({table,key:String(row.key),ordinal:Number(row.ordinal),value:JSON.parse(String(row.payload))})+'\n');
      for(const row of db.prepare('SELECT payload FROM messages ORDER BY chat,id').iterate())hash.update(JSON.stringify(JSON.parse(String(row.payload)))+'\n');return {sha256:hash.digest('hex')};
    }
    case 'query-plan':return db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM messages WHERE chat=? ORDER BY at DESC,id DESC LIMIT 100').all(request.chat);
    case 'backup':try{db.prepare('VACUUM INTO ?').run(request.path);return {ok:true};}catch{throw error('DATABASE_BACKUP_FAILED','备份未完成，请检查目标是否已存在、空间和访问权限；当前数据库保持可用。');}
    case 'export-social':{
      if(!isAbsolute(request.path))throw error('DATABASE_REQUEST_INVALID','导出目标必须为绝对路径。');
      const staging=request.path+'.export-'+randomUUID();let descriptor:number|undefined,created=false;
      try{
        const metadata=execute({action:'metadata'}) as {rows:EntityRow[]},data=rawDataFromRows(metadata.rows);descriptor=openSync(staging,'wx',0o600);created=true;
        writeAll(descriptor,'{"messages":[');let count=0;
        for(const row of db.prepare('SELECT payload FROM messages ORDER BY at,id').iterate()){if(count)writeAll(descriptor,',');writeAll(descriptor,String(row.payload));count++;}
        const {messages:_,...rest}=data;writeAll(descriptor,'],'+JSON.stringify(rest).slice(1)+'\n');fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
        linkSync(staging,request.path);unlinkSync(staging);created=false;return {messages:count};
      }catch{throw error('DATABASE_EXPORT_FAILED','导出未完成，请检查目标是否已存在、空间和访问权限；原数据保持不变。');}
      finally{if(descriptor!==undefined)try{closeSync(descriptor);}catch{}if(created)try{unlinkSync(staging);}catch{}}
    }
    case 'close':db.close();return {closed:true};
    default:throw error('DATABASE_REQUEST_INVALID','未知数据库操作。');
  }
}
try{
  db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
  const version=Number(Object.values(db.prepare('PRAGMA user_version').get()!)[0]),app=Number(Object.values(db.prepare('PRAGMA application_id').get()!)[0]);
  if(version>2)throw error('DATABASE_SCHEMA_NEWER','数据库版本较新，请使用兼容的程序版本。');
  if(version===0){
    if(Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table'").get()!.n))throw error('DATABASE_INVALID','数据文件不是受支持的数据库。');
    transaction(()=>{
      db.exec('CREATE TABLE runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE messages(chat TEXT NOT NULL,id INTEGER NOT NULL,user TEXT NOT NULL,name TEXT NOT NULL,at REAL NOT NULL,text TEXT NOT NULL,self INTEGER NOT NULL,recalled INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(chat,id)) WITHOUT ROWID; CREATE INDEX messages_chat_at ON messages(chat,at DESC,id DESC); CREATE INDEX messages_at ON messages(at DESC,id DESC); CREATE INDEX messages_incoming ON messages(chat,at DESC,id DESC) WHERE self=0 AND recalled=0;');
      for(const table of entityTables)db.exec(`CREATE TABLE ${tableName(table)}(key TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,chat TEXT NOT NULL,at REAL NOT NULL,state TEXT NOT NULL,due REAL NOT NULL,retry_at REAL NOT NULL,payload TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX ${table}_chat_at ON ${tableName(table)}(chat,at DESC);`);
      db.exec('CREATE INDEX tasks_due ON entity_tasks(state,due,retry_at); PRAGMA user_version=1; PRAGMA application_id=1464357708;');setMeta('revision',0);setMeta('initialized',false);setMeta('metadata_bytes',0);setMeta('messages_count',0);
    });
  }else if(app!==1464357708)throw error('DATABASE_INVALID','数据文件标识不匹配。');
  if(version<2)transaction(()=>createUsageSchema(db));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
  port.postMessage({type:'ready'});
  port.on('message',({id,request}:{id:number;request:DatabaseRequest})=>{
    const started=performance.now();
    try{
      const reads=['metadata','query-messages','lookup-messages','latest-incoming','integrity','fingerprint','query-plan','export-social','usage-summary'];
      const result=reads.includes(request.action)?readSnapshot(()=>execute(request)):execute(request);if(Buffer.byteLength(JSON.stringify(result))>DATABASE_LIMITS.responseBytes)throw error('DATABASE_RESPONSE_TOO_LARGE','查询结果过大，请缩小查询范围或分页读取。');
      port.postMessage({id,ok:true,result,elapsedMs:performance.now()-started});if(request.action==='close')port.close();
    }catch(failure){const e=failure as Error&{code?:string;errcode?:number};port.postMessage({id,ok:false,error:{code:e.code?.startsWith('DATABASE_')?e.code:e.errcode===13?'ENOSPC':'DATABASE_OPERATION_FAILED',message:e.code?.startsWith('DATABASE_')?e.message:'数据库操作失败，请保留数据并查看诊断。'}});}
  });
}catch(failure){const e=failure as Error&{code?:string};port.postMessage({type:'failed',error:{code:e.code?.startsWith('DATABASE_')?e.code:'DATABASE_OPEN_FAILED',message:e.code?.startsWith('DATABASE_')?e.message:'数据库无法打开，请保留原文件并检查磁盘和权限。'}});try{db!?.close();}catch{}port.close();}
