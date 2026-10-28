import type {DatabaseSync} from 'node:sqlite';
import type {OperationDatabaseRequest,StoredOperation} from './operation-types.js';

type Context={db:DatabaseSync;meta:(key:string)=>unknown;setMeta:(key:string,value:unknown)=>void;transaction:<T>(fn:()=>T)=>T;error:(code:string,message:string)=>Error};
type Row={id:string;owner:string;state:string;metadata:string;result:string;error:string;bytes:number;at:number;date:string;hash:string};
const fail=(message:string)=>Object.assign(new Error(message),{code:'DATABASE_OPERATION_CONFLICT'});
const json=(value:unknown,max=262144)=>{const text=JSON.stringify(value??null);if(Buffer.byteLength(text)>max)throw Object.assign(new Error('动作记录超过支持大小，本次不继续提交。'),{code:'DATABASE_STATE_LIMIT'});return text;};
function account(context:Context,delta:number){const next=Number(context.meta('operations_bytes')??0)+delta;if(next<0||next>128*1024*1024)throw Object.assign(new Error('动作记录达到支持容量，请先整理已核对历史。'),{code:'DATABASE_STATE_LIMIT'});context.setMeta('operations_bytes',next);}
function requireRow(context:Context,id:string,owner?:string):Row{
  const row=context.db.prepare('SELECT * FROM external_operations WHERE id=?').get(id) as Row|undefined;if(!row||owner!==undefined&&row.owner!==owner)throw fail('动作不属于当前执行实例，不能继续提交。');return row;
}
function stored(row:Row):StoredOperation{return {record:JSON.parse(row.metadata),state:row.state as StoredOperation['state'],owner:row.owner,at:row.at,date:row.date,result:JSON.parse(row.result),error:row.error};}
function patch(context:Context,row:Row,state:string,result=row.result,error=row.error){
  const bytes=Buffer.byteLength(row.metadata)+Buffer.byteLength(result)+Buffer.byteLength(error)+512;account(context,bytes-row.bytes);
  context.db.prepare('UPDATE external_operations SET state=?,result=?,error=?,bytes=? WHERE id=?').run(state,result,error,bytes,row.id);
}
function prune(context:Context,date:string){
  const cutoff=new Date(Date.parse(date+'T00:00:00Z')-31*86400000).toISOString().slice(0,10),rows=context.db.prepare("SELECT id,bytes FROM external_operations WHERE date<? AND state IN ('completed','failed') ORDER BY date,at LIMIT 256").all(cutoff);
  let bytes=0;for(const row of rows){bytes+=Number(row.bytes)+Number(context.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM external_steps WHERE operation_id=?').get(String(row.id))!.n);context.db.prepare('DELETE FROM external_operations WHERE id=?').run(String(row.id));}
  if(rows.length){account(context,-bytes);context.setMeta('operations_count',Number(context.meta('operations_count')??0)-rows.length);}
}
export function createOperationSchema(db:DatabaseSync){db.exec("CREATE TABLE external_operations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,account INTEGER NOT NULL,chat TEXT NOT NULL,turn TEXT NOT NULL,semantic_hash TEXT NOT NULL,hash TEXT NOT NULL,date TEXT NOT NULL,at REAL NOT NULL,state TEXT NOT NULL,metadata TEXT NOT NULL,result TEXT NOT NULL DEFAULT 'null',error TEXT NOT NULL DEFAULT '',bytes INTEGER NOT NULL) WITHOUT ROWID;CREATE INDEX external_operations_chat ON external_operations(account,chat,at DESC);CREATE INDEX external_operations_date ON external_operations(date,state);CREATE INDEX external_operations_semantic ON external_operations(turn,semantic_hash,state);CREATE TABLE external_steps(operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,at REAL NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL DEFAULT 'null',error TEXT NOT NULL DEFAULT '',bytes INTEGER NOT NULL,PRIMARY KEY(operation_id,sequence),FOREIGN KEY(operation_id) REFERENCES external_operations(id) ON DELETE CASCADE) WITHOUT ROWID;CREATE INDEX external_steps_unknown ON external_steps(name,hash,state);PRAGMA user_version=5;");}

/** Called inside the same quota transaction; no remote effect can use an unreserved action. */
export function reserveOperation(context:Context,reference:{id:string;owner:string}){
  const row=requireRow(context,reference.id,reference.owner);if(!['created','reserved','submitting'].includes(row.state))throw fail('动作已结束或结果待核对，不能再次预扣执行。');
  if(row.state==='created')patch(context,row,'reserved');
}

export function executeOperations(request:OperationDatabaseRequest,context:Context):unknown{
  const {db,transaction}=context;
  if(!context.meta('usage_imported'))throw context.error('DATABASE_NOT_INITIALIZED','动作额度仓储尚未完成导入。');
  if(request.action==='usage-op-read'){const row=db.prepare('SELECT * FROM external_operations WHERE id=?').get(request.id) as Row|undefined;return row?stored(row):null;}
  if(request.action==='usage-op-list'){
    if(!Number.isSafeInteger(request.account)||request.account<=0||request.chat!==undefined&&request.chat.length>128)throw fail('动作查询范围无效。');
    const where='account=?'+(request.chat===undefined?'':' AND chat=?'),args=request.chat===undefined?[request.account]:[request.account,request.chat],limit=Math.min(100,Math.max(1,Math.floor(request.limit))),offset=Math.min(1000000,Math.max(0,Math.floor(request.offset)));
    const rows=db.prepare(`SELECT id,turn,account,chat,state,at,error,json_extract(metadata,'$.user') AS user,json_extract(metadata,'$.origin') AS origin,json_extract(metadata,'$.tool') AS tool,json_extract(metadata,'$.summary') AS summary FROM external_operations WHERE ${where} ORDER BY at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset).map(row=>({record:{id:String(row.id),turn:String(row.turn),account:Number(row.account),chat:String(row.chat),user:String(row.user),origin:String(row.origin),tool:String(row.tool),summary:String(row.summary)},state:String(row.state),at:Number(row.at),error:String(row.error)}));
    return {rows,total:Number(db.prepare(`SELECT COUNT(*) AS n FROM external_operations WHERE ${where}`).get(...args)!.n)};
  }
  return transaction(()=>{
    if(request.action==='usage-op-recover'){
      const recovered=Number(db.prepare("UPDATE external_operations SET state='unknown' WHERE state IN ('created','reserved','submitting')").run().changes);
      db.exec("UPDATE external_steps SET state='unknown' WHERE state='submitting';");return {recovered};
    }
    if(request.action==='usage-op-begin'){
      const r=request.record;if(!/^[a-zA-Z0-9:_-]{8,128}$/.test(r.id)||!r.turn||r.turn.length>256||!Number.isSafeInteger(r.account)||r.account<=0||[r.chat,r.user].some(value=>typeof value!=='string'||value.length>128)||!['message','notice','background','owner','system'].includes(r.origin)||!r.tool||r.tool.length>64||typeof r.summary!=='string'||r.summary.length>500||!request.owner||request.owner.length>128||!/^\d{4}-\d{2}-\d{2}$/.test(request.date)||!Number.isFinite(request.at)||![request.hash,request.semanticHash].every(hash=>/^[a-f0-9]{64}$/.test(hash)))throw fail('动作身份或登记参数无效。');
      const previous=db.prepare('SELECT * FROM external_operations WHERE id=?').get(r.id) as Row|undefined;
      if(previous){if(previous.hash!==request.hash)throw fail('相同动作编号不能更换身份、目标或内容。');return {claimed:false,operation:stored(previous)};}
      if(db.prepare("SELECT 1 FROM external_operations WHERE turn=? AND semantic_hash=? AND state='unknown' LIMIT 1").get(r.turn,request.semanticHash))throw fail('本轮相同内容的动作结果待核对，不会自动再次提交。');
      prune(context,request.date);if(Number(context.meta('operations_count')??0)>=200000)throw context.error('DATABASE_STATE_LIMIT','动作数量达到支持上限，请先整理历史。');
      const metadata=json(r),bytes=Buffer.byteLength(metadata)+516;account(context,bytes);
      db.prepare('INSERT INTO external_operations(id,owner,account,chat,turn,semantic_hash,hash,date,at,state,metadata,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,request.owner,r.account,r.chat,r.turn,request.semanticHash,request.hash,request.date,request.at,'created',metadata,bytes);context.setMeta('operations_count',Number(context.meta('operations_count')??0)+1);return {claimed:true,operation:stored(requireRow(context,r.id))};
    }
    if(typeof request.owner!=='string'||!request.owner||request.owner.length>128)throw fail('动作执行实例无效。');const row=requireRow(context,request.id,request.owner);
    if(request.action==='usage-op-submit'){
      if(!['reserved','submitting'].includes(row.state)||!Number.isSafeInteger(request.sequence)||request.sequence<0||request.sequence>=16||!request.name||request.name.length>64||!/^[a-f0-9]{64}$/.test(request.hash)||!Number.isFinite(request.at))throw fail('动作尚未预扣、已结束或步骤超出上限，拒绝提交。');
      const prior=db.prepare('SELECT hash,state,result FROM external_steps WHERE operation_id=? AND sequence=?').get(request.id,request.sequence);if(prior){if(prior.hash!==request.hash)throw fail('动作步骤不能更换内容。');return {claimed:false,state:String(prior.state),result:JSON.parse(String(prior.result))};}
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM external_steps WHERE operation_id=?').get(request.id)!.n)!==request.sequence)throw fail('动作步骤序号不连续，不能跳过尚未执行的步骤。');
      if(db.prepare("SELECT 1 FROM external_steps s JOIN external_operations o ON o.id=s.operation_id WHERE o.turn=(SELECT turn FROM external_operations WHERE id=?) AND s.name=? AND s.hash=? AND s.state='unknown' LIMIT 1").get(request.id,request.name,request.hash))throw fail('本轮相同外部提交结果待核对，不能换工具或临时编号再次发送。');
      if(db.prepare("SELECT 1 FROM external_steps WHERE operation_id=? AND state<>'completed' LIMIT 1").get(request.id))throw fail('前一步骤尚未确认，不能继续提交后续动作。');
      const payload=json(request.payload),bytes=Buffer.byteLength(payload)+Buffer.byteLength(request.name)+260;account(context,bytes);db.prepare('INSERT INTO external_steps(operation_id,sequence,name,hash,at,state,payload,bytes) VALUES(?,?,?,?,?,?,?,?)').run(request.id,request.sequence,request.name,request.hash,request.at,'submitting',payload,bytes);patch(context,row,'submitting');return {claimed:true};
    }
    if(request.action==='usage-op-step'){
      const step=db.prepare('SELECT * FROM external_steps WHERE operation_id=? AND sequence=?').get(request.id,request.sequence);if(!step)throw fail('动作步骤不存在。');
      const result=json(request.result,65536),error=String(request.error??'').slice(0,2000);if(step.state!=='submitting'){if(step.state!==request.state||step.result!==result||step.error!==error)throw fail('已结算动作步骤不能覆盖。');return {reused:true};}
      if(!['completed','unknown'].includes(request.state))throw fail('动作步骤状态无效。');const bytes=Buffer.byteLength(String(step.payload))+Buffer.byteLength(String(step.name))+Buffer.byteLength(result)+Buffer.byteLength(error)+256;account(context,bytes-Number(step.bytes));db.prepare('UPDATE external_steps SET state=?,result=?,error=?,bytes=? WHERE operation_id=? AND sequence=?').run(request.state,result,error,bytes,request.id,request.sequence);if(request.state==='unknown')patch(context,row,'unknown',row.result,error);return {reused:false};
    }
    if(request.action==='usage-op-complete'){
      const result=json(request.result,524288);if(row.state==='completed'){if(row.result!==result)throw fail('已完成动作的返回值不能覆盖。');return {reused:true};}
      if(!['created','reserved','submitting'].includes(row.state)||db.prepare("SELECT 1 FROM external_steps WHERE operation_id=? AND state<>'completed' LIMIT 1").get(request.id))throw fail('动作仍有未确认步骤，不能标记成功。');patch(context,row,'completed',result,'');return {reused:false};
    }
    if(request.action==='usage-op-fail'){
      if(['completed','failed','unknown'].includes(row.state))return {state:row.state};const state=row.state==='submitting'?'unknown':'failed';patch(context,row,state,row.result,request.error.slice(0,2000));return {state};
    }
    throw fail('未知动作登记操作。');
  });
}
