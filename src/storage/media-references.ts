import type {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {entityTables} from './database-types.js';
import {ownedMediaName} from './media-cache-types.js';
import {mediaNames,MEDIA_REFERENCE_LIMITS,type MediaReferenceRequest} from './media-reference-types.js';

type Context={db:DatabaseSync;meta:(key:string)=>unknown;setMeta:(key:string,value:unknown)=>void;transaction:<T>(fn:()=>T)=>T};
type Progress={table:number;key?:string;chat?:string;id?:number;sequence?:number};
const tables=[...entityTables.map(table=>'entity_'+table),'messages','external_operations','external_steps'];
const invalid=(message:string)=>Object.assign(new Error(message),{code:'DATABASE_MEDIA_INVALID'});
export const entityMediaSource=(table:string,key:string)=>`e/${table}/${key}`;
export const messageMediaSource=(chat:string,id:number)=>`m/${chat}/${id}`;

export function createMediaReferenceSchema(db:DatabaseSync){
  db.exec("CREATE TABLE IF NOT EXISTS media_references(source TEXT NOT NULL,name TEXT NOT NULL,operation_id TEXT,PRIMARY KEY(source,name),FOREIGN KEY(operation_id) REFERENCES external_operations(id) ON DELETE CASCADE) WITHOUT ROWID;CREATE INDEX IF NOT EXISTS media_references_name ON media_references(name,operation_id);INSERT OR IGNORE INTO runtime_meta(key,value) VALUES('media_refs_count','0');CREATE TRIGGER IF NOT EXISTS media_refs_insert AFTER INSERT ON media_references BEGIN UPDATE runtime_meta SET value=CAST(value AS INTEGER)+1 WHERE key='media_refs_count';END;CREATE TRIGGER IF NOT EXISTS media_refs_delete AFTER DELETE ON media_references BEGIN UPDATE runtime_meta SET value=CAST(value AS INTEGER)-1 WHERE key='media_refs_count';END;");
  for(const table of entityTables)db.exec(`CREATE TRIGGER IF NOT EXISTS media_refs_${table}_delete AFTER DELETE ON entity_${table} BEGIN DELETE FROM media_references WHERE source='e/${table}/'||old.key;END;`);
  db.exec("CREATE TRIGGER IF NOT EXISTS media_refs_message_delete AFTER DELETE ON messages BEGIN DELETE FROM media_references WHERE source='m/'||old.chat||'/'||old.id;END;PRAGMA user_version=9;");
}
export function replaceMediaReferences(db:DatabaseSync,source:string,payload:string,operationId:string|null=null){
  const names=mediaNames(payload),count=Number(db.prepare("SELECT value FROM runtime_meta WHERE key='media_refs_count'").get()!.value),previous=Number(db.prepare('SELECT COUNT(*) AS n FROM media_references WHERE source=?').get(source)!.n);
  if(count-previous+names.length>MEDIA_REFERENCE_LIMITS.total)throw Object.assign(new Error('媒体引用索引达到支持容量，请先整理历史'),{code:'DATABASE_STATE_LIMIT'});
  db.prepare('DELETE FROM media_references WHERE source=?').run(source);const insert=db.prepare('INSERT INTO media_references(source,name,operation_id) VALUES(?,?,?)');for(const name of names)insert.run(source,name,operationId);
}
export function executeMediaReferences(request:MediaReferenceRequest,c:Context):unknown{
  const {db,meta,setMeta,transaction}=c,status=()=>({ready:Number((meta('media_refs_progress') as Progress|undefined)?.table??0)>=tables.length,references:Number(meta('media_refs_count')??0)});
  if(request.action==='media-refs-status')return status();
  if(request.action==='media-refs-query'){
    if(!Array.isArray(request.names)||request.names.length>MEDIA_REFERENCE_LIMITS.query||request.names.some(name=>typeof name!=='string'||!ownedMediaName(name)))throw invalid('媒体引用查询范围无效');
    const names=[...new Set(request.names.map(name=>name.toLowerCase()))];if(!names.length)return {...status(),names:[]};
    return {...status(),names:db.prepare(`SELECT DISTINCT r.name FROM media_references r LEFT JOIN external_operations o ON o.id=r.operation_id WHERE r.name IN (${names.map(()=>'?').join(',')}) AND (r.operation_id IS NULL OR o.id IS NULL OR o.state NOT IN ('completed','failed'))`).all(...names).map(row=>String(row.name))};
  }
  return transaction(()=>{
    if(request.action==='media-refs-pin'){
      if(typeof request.name!=='string'||!ownedMediaName(request.name)||typeof request.operationId!=='string'||!request.operationId||request.operationId.length>128||typeof request.owner!=='string'||!request.owner||request.owner.length>128)throw invalid('媒体引用凭证无效');
      const row=db.prepare('SELECT state,owner FROM external_operations WHERE id=?').get(request.operationId);if(!row||row.owner!==request.owner||!['created','reserved','submitting'].includes(String(row.state)))throw invalid('媒体不属于当前有效动作');
      const source='p/'+request.operationId,names=db.prepare('SELECT name FROM media_references WHERE source=?').all(source).map(row=>String(row.name));names.push(request.name);replaceMediaReferences(db,source,JSON.stringify(names),request.operationId);return {ok:true};
    }
    if(request.action!=='media-refs-backfill')throw invalid('媒体引用操作无效');
    const started=performance.now(),progress=(meta('media_refs_progress') as Progress|undefined)??{table:0};let processed=0,bytes=0;
    while(progress.table<tables.length&&processed<MEDIA_REFERENCE_LIMITS.batch&&bytes<MEDIA_REFERENCE_LIMITS.bytes&&performance.now()-started<MEDIA_REFERENCE_LIMITS.milliseconds){
      const table=tables[progress.table];let rows:Iterable<Record<string,unknown>>;
      if(table==='messages')rows=db.prepare('SELECT chat,id,payload FROM messages'+(progress.chat===undefined?'':' WHERE (chat,id)>(?,?)')+' ORDER BY chat,id LIMIT 64').iterate(...(progress.chat===undefined?[]:[progress.chat,progress.id!]));
      else if(table==='external_steps')rows=db.prepare('SELECT operation_id,sequence,payload,result FROM external_steps'+(progress.key===undefined?'':' WHERE (operation_id,sequence)>(?,?)')+' ORDER BY operation_id,sequence LIMIT 64').iterate(...(progress.key===undefined?[]:[progress.key,progress.sequence!]));
      else{const key=table==='external_operations'?'id':'key';rows=db.prepare(`SELECT ${key},${table==='external_operations'?'metadata,result':'payload'} FROM ${table}`+(progress.key===undefined?'':` WHERE ${key}>?`)+` ORDER BY ${key} LIMIT 64`).iterate(...(progress.key===undefined?[]:[progress.key]));}
      let found=false,exhausted=true;
      for(const row of rows){found=true;let source:string,payload:string,operationId:string|null=null;
        if(table==='messages'){source=messageMediaSource(String(row.chat),Number(row.id));payload=String(row.payload);progress.chat=String(row.chat);progress.id=Number(row.id);}
        else if(table==='external_steps'){source=`s/${row.operation_id}/${row.sequence}`;payload=String(row.payload)+'\n'+String(row.result);operationId=String(row.operation_id);progress.key=operationId;progress.sequence=Number(row.sequence);}
        else if(table==='external_operations'){source='o/'+row.id;payload=String(row.metadata)+'\n'+String(row.result);operationId=String(row.id);progress.key=operationId;}
        else{source=entityMediaSource(table.slice(7),String(row.key));payload=String(row.payload);progress.key=String(row.key);}
        replaceMediaReferences(db,source,payload,operationId);processed++;bytes+=Buffer.byteLength(payload);
        if(processed>=MEDIA_REFERENCE_LIMITS.batch||bytes>=MEDIA_REFERENCE_LIMITS.bytes||performance.now()-started>=MEDIA_REFERENCE_LIMITS.milliseconds){exhausted=false;break;}
      }
      if(!found||exhausted){progress.table++;delete progress.key;delete progress.chat;delete progress.id;delete progress.sequence;}
    }
    setMeta('media_refs_progress',progress);return {...status(),processed};
  });
}
