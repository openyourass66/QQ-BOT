import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {SocialEngine} from '../dist/qq/social-engine.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {validateSettings} from '../dist/core/settings.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-delivery-state-')),path=join(root,'social.json'),stores=[];const keep=store=>{stores.push(store);return store;};try{await run({root,path,keep});}finally{await Promise.allSettled(stores.map(store=>store.close()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const event=(id,chat=2)=>({message_type:'private',post_type:'message',self_id:1,user_id:chat,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'用户'},message:[{type:'text',data:{text:'消息'+id}}]});

test('入站去重与归档同事务，归档裁剪和重启后也不再次准入；历史补拉不提前消费新消息',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteSocialStore(path));await store.load();const first=event(1),second=event(2);assert.equal(await store.record(first,30,1),true);assert.equal(await store.record(second,30,1),true);assert.deepEqual((await store.messages('private:2')).map(item=>item.id),[2]);
  const repeated=await Promise.all(Array.from({length:32},()=>store.record(first,30,1)));assert.equal(repeated.filter(Boolean).length,0);await store.close();
  const reopened=keep(new SqliteSocialStore(path));await reopened.load();assert.equal(await reopened.record(first,30,1),false);assert.equal(await reopened.record(event(1,3),30,1),true);
  await reopened.add({id:99,chat:'private:2',user:2,name:'旧记录',at:Date.now(),text:'拉取的历史',segments:[],self:false,recalled:false});assert.equal(await reopened.record(event(99),30,1),true);assert.equal(await reopened.record(event(99),30,1),false);assert.equal((await reopened.message('private:2',99)).text,'拉取的历史');
}));

test('两个真实 Worker 的六十四次提醒领取只有一个成功，完成凭证不允许替换或复用',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteSocialStore(path));await seed.load();const task=await seed.addTask({chat:'private:2',creator:'2',text:'提醒',due:Date.now()-1000,interval:0});await seed.close();
  const a=keep(new DatabaseClient(path+'.sqlite')),b=keep(new DatabaseClient(path+'.sqlite')),metadata=await a.call({action:'metadata'}),now=Date.now();
  const results=await Promise.all(Array.from({length:64},(_,index)=>(index%2?a:b).call({action:'claim-task',expectedRevision:metadata.revision,id:task.id,claimId:randomUUID(),owner:'instance-'+index,now})));const claimed=results.filter(result=>result.claimed);assert.equal(claimed.length,1);const winner=claimed[0];
  const finish=(claimId,state,revision=winner.revision)=>a.call({action:'finish-task',expectedRevision:revision,id:task.id,claimId,state,error:'',retryAt:0,due:now});
  assert.equal((await finish('wrong','sent')).changed,false);const pending=await finish(winner.task.claim.id,'pending');assert.equal(pending.changed,true);
  const next=await a.call({action:'claim-task',expectedRevision:pending.revision,id:task.id,claimId:randomUUID(),owner:'next-instance',now});assert.equal(next.claimed,true);assert.equal((await finish(winner.task.claim.id,'sent',next.revision)).changed,false);const done=await finish(next.task.claim.id,'sent',next.revision);assert.equal(done.changed,true);assert.equal((await finish(next.task.claim.id,'sent',done.revision)).changed,false);
}));

test('提醒领取后重启保留待核对状态和凭证，不自动补发；取消先提交则无法领取',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteSocialStore(path));await store.load();const input={chat:'private:2',creator:'2',text:'提醒',due:Date.now()-1000,interval:0},task=await store.addTask(input),cancelled=await store.addTask(input);
  await store.update(data=>{data.tasks.find(item=>item.id===cancelled.id).state='cancelled';});assert.equal(await store.claimTask(cancelled.id,Date.now()),undefined);const claimed=await store.claimTask(task.id,Date.now());assert.ok(claimed.claim.id);await store.close();
  const reopened=keep(new SqliteSocialStore(path));await reopened.load();const saved=reopened.view('tasks').tasks.find(item=>item.id===task.id);assert.equal(saved.state,'unknown');assert.equal(saved.claim.id,claimed.claim.id);assert.equal((await reopened.dueTasks(Date.now())).length,0);assert.equal(await reopened.finishTask(task.id,claimed.claim.id,{state:'sent',error:'',retryAt:0}),false);
}));

test('睡眠恢复跳过周期积压和迟到超过二十四小时的一次提醒，正常到期仍只发送一次',()=>fixture(async({root,path,keep})=>{
  const store=keep(new SqliteSocialStore(path)),usage=keep(new SqliteDailyUsageStore(join(root,'usage.json')));await store.load();await usage.load();await store.account(1);const now=Date.now(),input={chat:'private:2',creator:'2',text:'提醒',due:now-2000,interval:0};
  const periodic=await store.addTask({...input,due:now-30*60000,interval:5*60000}),late=await store.addTask({...input,due:now-25*3600000}),normal=await store.addTask(input);const settings=validateSettings({}),sent=[];
  const api={call:async(action,args)=>{assert.equal(action,'send_private_msg');sent.push(args);return {message_id:sent.length};}};
  const engine=new SocialEngine(store,{capabilities:()=>({})},api,usage,()=>settings,async()=>true,()=>{},()=>{});await engine.tick(1,new AbortController().signal,async()=>{});await engine.tick(1,new AbortController().signal,async()=>{});
  const tasks=store.view('tasks').tasks;assert.equal(sent.length,1);assert.equal(tasks.find(item=>item.id===periodic.id).state,'pending');assert.ok(tasks.find(item=>item.id===periodic.id).due>now);assert.match(tasks.find(item=>item.id===periodic.id).error,/跳过积压/);assert.equal(tasks.find(item=>item.id===late.id).state,'failed');assert.equal(tasks.find(item=>item.id===normal.id).state,'sent');assert.equal(usage.used('reminders'),1);
}));

test('入站准入提交后宿主立即退出，重启不重新触发该帧或覆写原始归档',()=>fixture(async({path,keep})=>{
  const module=pathToFileURL(resolve('dist/storage/sqlite-social-store.js')).href,frame=event(77);
  const script=`import {SqliteSocialStore} from ${JSON.stringify(module)};const store=new SqliteSocialStore(process.argv[1]);await store.load();await store.record(${JSON.stringify(frame)},30,100);process.exit(42);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
  const store=keep(new SqliteSocialStore(path));await store.load();assert.equal(await store.record({...frame,message:[{type:'text',data:{text:'同编号重放不能改正文'}}]},30,100),false);assert.equal((await store.message('private:2',77)).text,'消息77');
}));

test('schema 3 升级保留任务和归档，既有入站身份不会因升级重新开放',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteSocialStore(path));await store.load();const frame=event(88);await store.record(frame,30,100);const task=await store.addTask({chat:'private:2',creator:'2',text:'保留任务',due:Date.now()-1,interval:0});await store.close();
  const old=new DatabaseSync(path+'.sqlite');try{old.exec('DROP TABLE incoming_receipts;DROP TABLE external_steps;DROP TABLE external_operations;PRAGMA user_version=3;');}finally{old.close();}
  const upgraded=keep(new SqliteSocialStore(path));await upgraded.load();assert.equal(await upgraded.record(frame,30,100),false);assert.equal((await upgraded.message('private:2',88)).text,'消息88');assert.equal((await upgraded.dueTasks(Date.now()))[0].id,task.id);
}));

test('提醒事务领取成功后强制结束宿主，恢复为未知且不重新领取',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteSocialStore(path));await store.load();const task=await store.addTask({chat:'private:2',creator:'2',text:'只领一次',due:Date.now()-1000,interval:0});await store.close();
  const module=pathToFileURL(resolve('dist/storage/sqlite-social-store.js')).href,script=`import {SqliteSocialStore} from ${JSON.stringify(module)};const store=new SqliteSocialStore(process.argv[1]);await store.load();await store.claimTask(process.argv[2],Date.now());process.exit(42);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path,task.id],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
  const recovered=keep(new SqliteSocialStore(path));await recovered.load();const saved=recovered.view('tasks').tasks.find(item=>item.id===task.id);assert.equal(saved.state,'unknown');assert.ok(saved.claim.owner);assert.equal(await recovered.claimTask(task.id,Date.now()),undefined);
}));
