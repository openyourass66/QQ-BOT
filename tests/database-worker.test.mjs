import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {DatabaseClient} from '../dist/storage/database-client.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-database-'));const client=new DatabaseClient(join(root,'social.sqlite'));try{await run({root,client});}finally{await client.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const message=(id,chat='private:2')=>({chat,id,user:2,name:'成员',at:Date.now()+id,text:`归档消息 ${id}`,segments:[],self:false,recalled:false});
async function initialized(client){await client.call({action:'complete-import',source:{fixture:true}});}

test('数据库按条目导入和查询，使用会话时间索引，重复编号保持会话隔离，备份可独立读取',()=>fixture(async({root,client})=>{
  const measurements=[];client.onMeasurement=(action,elapsed)=>measurements.push({action,elapsed});
  const rows=Array.from({length:1000},(_,id)=>({table:'messages',key:String(id),ordinal:id,value:message(id)}));rows.push({table:'messages',key:'other',ordinal:0,value:message(1,'group:3')});
  await client.call({action:'import',rows});await initialized(client);
  const page=await client.call({action:'query-messages',query:{chat:'private:2',limit:10,offset:10}});assert.equal(page.total,1000);assert.deepEqual(page.rows.map(m=>m.id),Array.from({length:10},(_,n)=>989-n));
  const exact=await client.call({action:'lookup-messages',refs:[{chat:'private:2',id:1},{chat:'group:3',id:1}]});assert.equal(exact.length,2);
  const plan=await client.call({action:'query-plan',chat:'private:2'});assert.match(JSON.stringify(plan),/messages_chat_at/);assert.doesNotMatch(JSON.stringify(plan),/TEMP B-TREE/);
  const state=await client.call({action:'metadata'});assert.equal(state.rows.length,0);assert.ok(measurements.every(m=>Number.isFinite(m.elapsed)&&m.elapsed>0));
  const backup=join(root,'consistent.sqlite');await client.call({action:'backup',path:backup});await assert.rejects(client.call({action:'backup',path:backup}));
  const copied=new DatabaseSync(backup,{readOnly:true});try{assert.equal(copied.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1001);}finally{copied.close();}
  assert.deepEqual((await client.call({action:'integrity'})).check,['ok']);
}));

test('增量消息写入原子更新联系人与保留期，重复写入幂等，事务失败回滚所有条目',()=>fixture(async({client})=>{
  await initialized(client);let revision=0;
  for(let id=1;id<=5;id++)revision=(await client.call({action:'add-message',expectedRevision:revision,entry:message(id),cutoff:0,perChat:3})).revision;
  assert.equal((await client.call({action:'query-messages',query:{}})).total,3);
  const duplicate=await client.call({action:'add-message',expectedRevision:revision,entry:message(5),cutoff:0,perChat:3});assert.equal(duplicate.inserted,false);assert.equal(duplicate.revision,revision);
  const before=await client.call({action:'metadata'});assert.equal(before.rows[0].value.chat,'private:2');
  await assert.rejects(client.call({action:'mutate',expectedRevision:revision,changes:[{table:'tasks',key:'first',ordinal:0,value:{chat:'private:2',state:'running'}},{table:'invalid-table',key:'bad',value:{}}]}));
  assert.deepEqual(await client.call({action:'metadata'}),before);
  await client.call({action:'mutate',expectedRevision:revision,changes:[{table:'tasks',key:'first',ordinal:0,value:{chat:'private:2',state:'pending'}}]});
  await assert.rejects(client.call({action:'mutate',expectedRevision:revision,changes:[]}),error=>error.code==='DATABASE_REVISION_CONFLICT');
}));

test('两个真实数据库工作线程争用同一修订号时仅一次成功，不能覆盖已提交状态',()=>fixture(async({client})=>{
  await initialized(client);const second=new DatabaseClient(client.path);
  try{
    await second.open();const results=await Promise.allSettled([client,second].map((connection,index)=>connection.call({action:'mutate',expectedRevision:0,changes:[{table:'state',key:'winner',ordinal:0,value:{winner:index}}]})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'DATABASE_REVISION_CONFLICT');assert.equal((await [client,second][results.findIndex(r=>r.status==='fulfilled')].call({action:'metadata'})).revision,1);
  }finally{await second.close();}
}));

test('Worker 队列有界，超限请求提前拒绝；退出拒绝所有未完成请求且后续不能假成功',()=>fixture(async({root})=>{
  const file=join(root,'controlled.mjs');await writeFile(file,"import{parentPort}from'node:worker_threads';parentPort.postMessage({type:'ready'});parentPort.on('message',({id,request})=>{if(request.action==='close'){parentPort.postMessage({id,ok:true,result:{},elapsedMs:1});parentPort.close()}else if(request.action==='integrity')process.exit(1);else setTimeout(()=>parentPort.postMessage({id,ok:true,result:{},elapsedMs:10}),100)});");
  const bounded=new DatabaseClient(join(root,'unused'),{maxPending:2,workerUrl:pathToFileURL(file)});let failures=0;bounded.onFailure=()=>failures++;
  try{
    await bounded.open();const first=bounded.call({action:'metadata'}),second=bounded.call({action:'metadata'});await assert.rejects(bounded.call({action:'metadata'}),error=>error.code==='DATABASE_QUEUE_FULL');await Promise.all([first,second]);assert.equal(bounded.pendingCount,0);
    const pending=bounded.call({action:'metadata'}),crash=bounded.call({action:'integrity'});const results=await Promise.allSettled([pending,crash]);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='DATABASE_WORKER_EXITED'));assert.equal(failures,1);assert.equal(bounded.pendingBytes,0);await assert.rejects(bounded.call({action:'metadata'}),/线程/);
  }finally{await bounded.close();}
}));

test('Worker 请求字节上限与超时明确失败，过新或损坏的数据文件不覆盖',()=>fixture(async({root})=>{
  const file=join(root,'timeout.mjs');await writeFile(file,"import{parentPort}from'node:worker_threads';parentPort.postMessage({type:'ready'});parentPort.on('message',()=>{});");
  const stalled=new DatabaseClient(join(root,'unused'),{timeoutMs:1000,maxPendingBytes:100,workerUrl:pathToFileURL(file)});
  try{
    await stalled.open();await assert.rejects(stalled.call({action:'complete-import',source:{large:'x'.repeat(200)}}),error=>error.code==='DATABASE_QUEUE_FULL');await assert.rejects(stalled.call({action:'metadata'}),error=>error.code==='DATABASE_WORKER_TIMEOUT');
  }finally{await stalled.close();}
  for(const newer of [false,true]){
    const path=join(root,newer?'newer.sqlite':'broken.sqlite');if(newer){const db=new DatabaseSync(path);db.exec('PRAGMA user_version=999');db.close();}else await writeFile(path,'original invalid database');
    const before=await readFile(path),candidate=new DatabaseClient(path);try{await assert.rejects(candidate.open());assert.deepEqual(await readFile(path),before);}finally{await candidate.close();}
  }
}));

test('写事务中工作线程崩溃时未提交修改自动回滚，原有已提交消息可恢复读取',()=>fixture(async({root,client})=>{
  await client.call({action:'import',rows:[{table:'messages',key:'one',ordinal:0,value:message(1)}]});await initialized(client);await client.close();
  const file=join(root,'crash.mjs');await writeFile(file,"import{parentPort,workerData}from'node:worker_threads';import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(workerData.path);parentPort.postMessage({type:'ready'});parentPort.on('message',()=>{db.exec(\"BEGIN IMMEDIATE;UPDATE runtime_meta SET value='999' WHERE key='revision'\");process.exit(1)});");
  const crashed=new DatabaseClient(client.path,{workerUrl:pathToFileURL(file)});try{await assert.rejects(crashed.call({action:'metadata'}),error=>error.code==='DATABASE_WORKER_EXITED');}finally{await crashed.close();}
  const reopened=new DatabaseClient(client.path);try{assert.equal((await reopened.call({action:'metadata'})).revision,0);assert.equal((await reopened.call({action:'query-messages',query:{}})).total,1);}finally{await reopened.close();}
}));

test('业务状态达到容量边界时原子拒绝增长，现有记录仍能读取、清理和继续使用',()=>fixture(async({client})=>{
  await initialized(client);let revision=0,count=0;const payload='x'.repeat(1024*1024);
  for(let index=0;index<20;index++){
    try{revision=(await client.call({action:'mutate',expectedRevision:revision,changes:[{table:'state',key:String(index),ordinal:index,value:{payload}}]})).revision;count++;}
    catch(error){assert.equal(error.code,'DATABASE_STATE_LIMIT');break;}
  }
  assert.ok(count>0&&count<20);const state=await client.call({action:'metadata'});assert.equal(state.rows.length,count);assert.equal(state.revision,revision);
  await client.call({action:'mutate',expectedRevision:revision,changes:[{table:'state',key:'0'},{table:'state',key:'recovered',ordinal:100,value:{small:true}}]});assert.equal((await client.call({action:'metadata'})).rows.find(row=>row.key==='recovered').value.small,true);
}));
