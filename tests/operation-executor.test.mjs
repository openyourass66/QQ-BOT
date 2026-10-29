import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {OperationExecutor} from '../dist/app/operation-executor.js';
import {currentOperation} from '../dist/core/operation-context.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-operation-executor-')),usage=new SqliteDailyUsageStore(join(root,'usage.json'));let executor;try{await usage.load();executor=new OperationExecutor(usage);await run({root,usage,executor});}finally{await executor?.close();await usage.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const record=(extra={})=>({id:randomUUID(),turn:'trusted-turn',account:1,chat:'private:2',user:'2',origin:'message',tool:'qq_reply',payload:{text:'实际文字',target:'private:2'},summary:'发送文字',...extra});
const signal=()=>new AbortController().signal,quotas=()=>[{key:'social-actions',amount:1,limit:10,label:'QQ 动作'}],deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {resolve,promise};};

test('并发重复动作合并成一次预扣和一次实际执行，已完成结果直接读取',()=>fixture(async({usage,executor})=>{
  const input=record(),gate=deferred(),entered=deferred();let calls=0;const execute=async()=>{await usage.consume(quotas);entered.resolve();await gate.promise;return executor.remote('send_private_msg',{user_id:2,message:'实际文字'},async()=>{calls++;return {message_id:123};});};
  const tasks=Array.from({length:32},()=>executor.run(input,signal(),()=>{},execute));await entered.promise;assert.equal(executor.size,1);assert.equal(usage.used('social-actions'),1);gate.resolve();const results=await Promise.all(tasks);assert.ok(results.every(result=>result.message_id===123));assert.equal(calls,1);assert.equal((await usage.operation(input.id)).state,'completed');
  assert.deepEqual(await executor.run(input,signal(),()=>{},async()=>{throw new Error('duplicate callback entered');}),{message_id:123});assert.equal(calls,1);assert.equal(usage.used('social-actions'),1);
}));

test('真实 HTTP 已收到请求但响应丢失时保留未知，相同编号和本轮相同内容均不再次发送',()=>fixture(async({usage,executor})=>{
  let calls=0,drop=true;const http=createServer(async(req,res)=>{for await(const _ of req){}calls++;if(drop){res.destroy();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({message_id:123}));});http.listen(0,'127.0.0.1');await once(http,'listening');
  const input=record(),execute=async()=>{await usage.consume(quotas);return executor.remote('send_private_msg',{user_id:2,message:'实际文字'},async()=>{const response=await fetch(`http://127.0.0.1:${http.address().port}`,{method:'POST',body:'body',signal:AbortSignal.timeout(3000)});return response.json();});};
  try{await assert.rejects(executor.run(input,signal(),()=>{},execute));assert.equal(calls,1);assert.equal((await usage.operation(input.id)).state,'unknown');await assert.rejects(executor.run(input,signal(),()=>{},execute),{code:'OPERATION_REPLAY_BLOCKED'});await assert.rejects(executor.run({...input,id:randomUUID()},signal(),()=>{},execute),{code:'DATABASE_OPERATION_CONFLICT'});assert.equal(calls,1);assert.equal(usage.used('social-actions'),1);
    drop=false;assert.equal((await executor.run({...input,id:randomUUID(),turn:'new-explicit-user-turn'},signal(),()=>{},execute)).message_id,123);assert.equal(calls,2);assert.equal(usage.used('social-actions'),2);
  }finally{http.closeAllConnections();await new Promise(done=>http.close(done));}
}));

test('排队后能力关闭或取消不进入外部请求；已预扣不退款且没有提交时明确失败',()=>fixture(async({usage,executor})=>{
  const input=record();let allowed=true,calls=0;await assert.rejects(executor.run(input,signal(),()=>{if(!allowed)throw new Error('能力已关闭');},async()=>{await usage.consume(quotas);allowed=false;return executor.remote('send_private_msg',{},async()=>{calls++;return {message_id:1};});}),/能力已关闭/);
  assert.equal(calls,0);assert.equal(usage.used('social-actions'),1);assert.equal((await usage.operation(input.id)).state,'failed');const cancelled=new AbortController();cancelled.abort();const other=record();await assert.rejects(executor.run(other,cancelled.signal,()=>{},async()=>{calls++;}));assert.equal(await usage.operation(other.id),null);assert.equal(calls,0);
}));

test('消息响应没有有效编号时不显示成功，停止阻止新动作并排空等待取消的执行',()=>fixture(async({usage,executor})=>{
  const input=record();let calls=0;await assert.rejects(executor.run(input,signal(),()=>{},async()=>{await usage.consume(quotas);return executor.remote('send_private_msg',{},async()=>{calls++;return {};});}),/未返回有效编号/);assert.equal(calls,1);assert.equal((await usage.operation(input.id)).state,'unknown');
  const ready=deferred(),waiting=record({turn:'waiting'}),task=executor.run(waiting,signal(),()=>{},async()=>{const scope=currentOperation();assert.equal(scope.record.account,1);return new Promise((_,reject)=>{scope.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});ready.resolve();});});const rejected=assert.rejects(task,/cancelled/);await ready.promise;await executor.close();await rejected;assert.equal(executor.size,0);assert.equal((await usage.operation(waiting.id)).state,'failed');await assert.rejects(executor.run(record(),signal(),()=>{},async()=>{}));
}));

test('动作摘要写入失败不抹掉已确认结果，保留权威账本并报告投影故障',()=>fixture(async({usage})=>{
  let failures=0;const executor=new OperationExecutor(usage,{finished:async()=>{throw new Error('projection write failed');},onProjectionFailure:()=>failures++});const input=record();try{assert.deepEqual(await executor.run(input,signal(),()=>{},async()=>{await usage.consume(quotas);return executor.remote('send_private_msg',{},async()=>({message_id:5}));}),{message_id:5});assert.equal(failures,1);assert.equal((await usage.operation(input.id)).state,'completed');}finally{await executor.close();}
}));
