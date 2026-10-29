import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-operation-ledger-')),path=join(root,'usage.json'),stores=[];const keep=store=>{stores.push(store);return store;};try{await run({root,path,keep});}finally{await Promise.allSettled(stores.map(store=>store.close()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const record=(extra={})=>({id:randomUUID(),turn:'trusted-turn',account:1,chat:'private:2',user:'2',origin:'message',tool:'qq_reply',payload:{text:'内容',target:'private:2'},summary:'发送文字',...extra});
const quotas=(limit=10)=>[{key:'social-actions',amount:1,limit,label:'QQ 动作'}];

test('动作状态与总额、专用额度共同事务预扣，专用拒绝不留下预扣或开放提交',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteDailyUsageStore(path));await store.load();const original=record();assert.equal((await store.beginOperation(original)).claimed,true);await assert.rejects(store.submitOperation(original.id,0,'send_private_msg',{user_id:2,message:'内容'}),/尚未预扣/);
  await assert.rejects(store.reserveOperation(original.id,0,()=>[...quotas(),{key:'dedicated',amount:1,limit:0,label:'专用'}]),{code:'DATABASE_QUOTA_EXCEEDED'});assert.equal(store.used('social-actions'),0);assert.equal((await store.operation(original.id)).state,'created');
  let callbacks=0;const get=()=>[...quotas(),{key:'dedicated',amount:1,limit:1,label:'专用'}];assert.equal((await store.reserveOperation(original.id,0,get,()=>callbacks++)).reused,false);assert.equal((await store.operation(original.id)).state,'reserved');assert.equal(store.used('social-actions'),1);assert.equal(store.used('dedicated'),1);assert.equal((await store.reserveOperation(original.id,0,get,()=>callbacks++)).reused,true);assert.equal(callbacks,1);
}));

test('两个真实 Worker 同一逻辑动作仅一人取得执行权，其他实例不能预扣或提交',()=>fixture(async({path,keep})=>{
  const a=keep(new SqliteDailyUsageStore(path)),b=keep(new SqliteDailyUsageStore(path));await a.load();await b.load();const original=record(),attempts=await Promise.all(Array.from({length:32},(_,index)=>(index%2?a:b).beginOperation(original)));assert.equal(attempts.filter(result=>result.claimed).length,1);
  const owner=attempts.find(result=>result.claimed).operation.owner,winner=owner===a.instanceId?a:b,loser=owner===a.instanceId?b:a;await assert.rejects(loser.reserveOperation(original.id,0,()=>quotas()),{code:'DATABASE_OPERATION_CONFLICT'});assert.equal(loser.used('social-actions'),0);await winner.reserveOperation(original.id,0,()=>quotas());assert.equal((await winner.submitOperation(original.id,0,'send_private_msg',{user_id:2,message:'内容'})).claimed,true);await assert.rejects(loser.submitOperation(original.id,0,'send_private_msg',{user_id:2,message:'内容'}),{code:'DATABASE_OPERATION_CONFLICT'});
}));

test('步骤顺序、相同编号内容绑定及最终返回值持久化，重复读取不再次执行',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteDailyUsageStore(path));await store.load();const original=record();await store.beginOperation(original);await store.reserveOperation(original.id,0,()=>quotas());const payload={user_id:2,message:'内容'};await assert.rejects(store.submitOperation(original.id,1,'send_private_msg',payload),/序号不连续/);
  assert.equal((await store.submitOperation(original.id,0,'send_private_msg',payload)).claimed,true);assert.equal((await store.submitOperation(original.id,0,'send_private_msg',payload)).claimed,false);await assert.rejects(store.submitOperation(original.id,0,'send_private_msg',{...payload,user_id:3}),/不能更换内容/);await assert.rejects(store.completeOperation(original.id,{sent:true}),/未确认步骤/);
  await store.finishOperationStep(original.id,0,'completed',{message_id:123});await store.finishOperationStep(original.id,0,'completed',{message_id:123});await assert.rejects(store.finishOperationStep(original.id,0,'completed',{message_id:999}),/不能覆盖/);await store.completeOperation(original.id,{sent:true,message_id:123});const duplicate=await store.beginOperation(original);assert.equal(duplicate.claimed,false);assert.equal(duplicate.operation.state,'completed');assert.deepEqual(duplicate.operation.result,{sent:true,message_id:123});await assert.rejects(store.beginOperation({...original,payload:{text:'替换正文'}}),/不能更换身份/);assert.equal(store.used('social-actions'),1);
  const scoped=await store.operationSummaries(1,'private:2');assert.equal(scoped.total,1);assert.equal(scoped.rows[0].record.payload,undefined);assert.equal((await store.operationSummaries(2,'private:2')).total,0);
}));

test('未知步骤阻止后续与本轮自动重试，新轮次合法相同内容不永久去重',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteDailyUsageStore(path));await store.load();const original=record();await store.beginOperation(original);await store.reserveOperation(original.id,0,()=>quotas());await store.submitOperation(original.id,0,'send_private_msg',{user_id:2,message:'内容'});await store.finishOperationStep(original.id,0,'unknown',undefined,'响应丢失');assert.equal((await store.operation(original.id)).state,'unknown');await assert.rejects(store.submitOperation(original.id,1,'send_private_msg',{user_id:2,message:'内容'}),/拒绝提交/);await assert.rejects(store.beginOperation({...original,id:randomUUID()}),/结果待核对/);
  const next=record({turn:'explicit-new-turn'});assert.equal((await store.beginOperation(next)).claimed,true);assert.equal((await store.failOperation(next.id,'提交前关闭能力')).state,'failed');assert.equal(store.used('social-actions'),1);
  const changedHandle=record({payload:{post_id:'new-temporary-handle'}});await store.beginOperation(changedHandle);await store.reserveOperation(changedHandle.id,0,()=>quotas());await assert.rejects(store.submitOperation(changedHandle.id,0,'send_private_msg',{user_id:2,message:'内容'}),/不能换工具或临时编号/);
}));

test('提交阶段后强制结束宿主，额度与未知状态保留，重启不会得到新的执行权',()=>fixture(async({path,keep})=>{
  const original=record(),module=pathToFileURL(resolve('dist/storage/sqlite-usage-store.js')).href;
  const script=`import{SqliteDailyUsageStore}from ${JSON.stringify(module)};const store=new SqliteDailyUsageStore(process.argv[1]);await store.load();const operation=${JSON.stringify(original)};await store.beginOperation(operation);await store.reserveOperation(operation.id,0,()=>[{key:'social-actions',amount:1,limit:10,label:'QQ action'}]);await store.submitOperation(operation.id,0,'send_private_msg',{user_id:2,message:'body'});process.exit(42);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);const recovered=keep(new SqliteDailyUsageStore(path));await recovered.load();assert.equal(recovered.used('social-actions'),1);const retried=await recovered.beginOperation(original);assert.equal(retried.claimed,false);assert.equal(retried.operation.state,'unknown');await assert.rejects(recovered.reserveOperation(original.id,1,()=>quotas()),{code:'DATABASE_OPERATION_CONFLICT'});
}));

test('schema 4 升级保留原始额度与服务真实用量，动作记录大小边界在提交前拒绝',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteDailyUsageStore(path));await seed.load();const model={id:randomUUID(),turn:'model-turn',kind:'conversation',background:false,chat:'private:2',user:'2',provider:'fixture',model:'fixture',maxOutputTokens:128};await seed.reserveModel(model,()=>[{key:'service-requests',amount:1,limit:10,label:'service'}]);await seed.finishModel(model.id,'completed',{inputTokens:12,outputTokens:5});await seed.close();
  const old=new DatabaseSync(path+'.sqlite');try{old.exec('DROP TABLE external_steps;DROP TABLE external_operations;PRAGMA user_version=4;');}finally{old.close();}
  const store=keep(new SqliteDailyUsageStore(path));await store.load();assert.equal(store.used('service-requests'),1);assert.equal((await store.requestStatistics()).knownInputTokens,12);await assert.rejects(store.beginOperation(record({payload:{text:'x'.repeat(262145)}})),{code:'DATABASE_STATE_LIMIT'});assert.equal((await store.operationSummaries(1)).total,0);const original=record();await store.beginOperation(original);await assert.rejects(store.submitOperation(original.id,0,'send_private_msg',{}),/尚未预扣/);
}));
