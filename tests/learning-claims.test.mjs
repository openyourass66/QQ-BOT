import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SocialStore} from '../dist/qq/social-store.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {Cognition,cognitionRevision} from '../dist/agent/cognition.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {createServer} from 'node:http';
import {learningModel} from '../dist/agent/learning-model.js';
import {RequestBudget} from '../dist/agent/request-budget.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),signal=()=>new AbortController().signal;
const message={id:1,chat:'private:20001',user:20001,name:'甲',at:Date.now()-3600000,text:'我每天早上喝咖啡',segments:[{type:'text',data:{text:'我每天早上喝咖啡'}}],self:false,recalled:false};
async function fixture(run,Store=SqliteSocialStore){const root=await mkdtemp(join(tmpdir(),'qq-learning-claims-')),path=join(root,'social.json'),store=new Store(path),usage=new SqliteDailyUsageStore(join(root,'usage.json')),resources=[store,usage],keep=value=>{resources.push(value);return value;};try{await store.load();await usage.load();await store.add(message);const s=structuredClone(DEFAULT_SETTINGS);s.learning.chats=[message.chat];s.learning.memory=true;const batch=()=>({chat:message.chat,messages:[structuredClone(message)],memories:[],revision:cognitionRevision(store.view('memories','cognition'),message.chat)});await run({root,path,store,usage,s,batch,keep});}finally{await Promise.allSettled(resources.map(value=>value.close?.()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const claim=(extra={})=>({id:randomUUID(),chat:message.chat,at:Date.now(),batch:digest('batch'),sources:[1],...extra});

for(const [name,Store]of [['JSON 参考',SocialStore],['SQLite',SqliteSocialStore]])test(`${name}：同会话资料整理只领取一个，准备与运行阶段凭证不可混用`,()=>fixture(async({store})=>{
  const first=claim(),job=await store.claimLearning(first);assert.equal(job.state,'preparing');assert.equal(await store.claimLearning(claim()),undefined);
  assert.equal(await store.updateLearningClaim(job.id,'stale','preparing',()=>{throw new Error('旧凭证进入回调');}),false);
  assert.equal(await store.updateLearningClaim(job.id,job.claim.id,'running',()=>{}),false);
  assert.equal(await store.updateLearningClaim(job.id,job.claim.id,'preparing',d=>{d.cognition.jobs[0].state='running';}),true);
  assert.equal(await store.updateLearningClaim(job.id,job.claim.id,'preparing',()=>{}),false);
  await store.updateLearningClaim(job.id,job.claim.id,'running',d=>{d.cognition.jobs[0].state='unknown';});assert.equal(await store.claimLearning(claim()),undefined);
  const explicit=await store.claimLearning(claim({manual:true}));assert.equal(explicit.state,'preparing');
},Store));

test('两个真实 Worker 的六十四次学习领取只有一个成功，不同编号不能绕过同会话占用',()=>fixture(async({path,store,keep})=>{
  await store.close();const a=keep(new DatabaseClient(path+'.sqlite')),b=keep(new DatabaseClient(path+'.sqlite')),before=await a.call({action:'metadata'});
  const rows=await Promise.all(Array.from({length:64},(_,i)=>(i%2?a:b).call({action:'claim-learning',expectedRevision:before.revision,input:claim(),owner:'worker-'+i}))),winners=rows.filter(row=>row.claimed);assert.equal(winners.length,1);
  const winner=winners[0],result=await a.call({action:'mutate',expectedRevision:before.revision,guard:{table:'learning_jobs',key:winner.job.id,claimId:'old',state:'preparing'},changes:[]});assert.equal(result.changed,false);assert.equal(result.revision,winner.revision);
}));

test('两个整理服务并发时只进入一次准备/模型和额度；来源快照不随调用方修改',()=>fixture(async({store,usage,s,batch})=>{
  let release,entered;const ready=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});let prepares=0,models=0,seen;
  const prepare=async source=>{prepares++;seen=source.messages[0].text;await usage.consume(()=>[{key:'learning',amount:1,limit:10,label:'学习'}]);return {run:async()=>{models++;entered();await gate;return {memories:[],lexicon:[]};},close:async()=>{}};};
  const a=new Cognition(store,()=>s,usage,async()=>{throw new Error('不应使用旧路径');},()=>'',Date.now,prepare),b=new Cognition(store,()=>s,usage,async()=>{},()=>'',Date.now,prepare),input=batch();
  const one=a.run(input,signal());await ready;input.messages[0].text='调用方修改了原对象';assert.equal(await b.run(batch(),signal()),false);release();assert.equal(await one,true);assert.equal(seen,message.text);assert.equal(prepares,1);assert.equal(models,1);assert.equal(usage.used('learning'),1);assert.equal(store.view('cognition').cognition.jobs[0].state,'completed');
}));

test('预算拒绝删除尚未提交的准备记录且不推进游标，晚到提案不能覆盖结束的任务',()=>fixture(async({store,usage,s,batch})=>{
  let models=0;const denied=new Cognition(store,()=>s,usage,async()=>{models++;return {memories:[],lexicon:[]};},()=>'',Date.now,async()=>{throw new Error('额度已用完');});await assert.rejects(denied.run(batch(),signal()),/额度已用完/);assert.equal(models,0);assert.equal(store.view('cognition').cognition.scopes[message.chat],undefined);assert.equal(store.view('cognition').cognition.jobs.length,0);
  let release,entered;const gate=new Promise(done=>{release=done;}),ready=new Promise(done=>{entered=done;});const service=new Cognition(store,()=>s,usage,async()=>{entered();await gate;return {memories:[{user:'20001',text:'我每天早上喝咖啡',evidence:[{messageId:1,quote:message.text}]}],lexicon:[]};});const task=service.run(batch(),signal());await ready;
  await store.update(d=>{d.cognition.jobs[0].state='discarded';d.cognition.jobs[0].summary='主人已停止该任务';});release();await task;assert.equal(store.view('memories').memories.length,0);assert.equal(store.view('cognition').cognition.jobs[0].summary,'主人已停止该任务');
}));

for(const running of [false,true])test(`宿主在${running?'游标和运行状态提交':'准备领取'}后强制结束，恢复阶段明确且不重复提交模型`,()=>fixture(async({path,store,keep})=>{
  await store.close();const input=claim(),module=pathToFileURL(resolve('dist/storage/sqlite-social-store.js')).href;
  const script=`import{SqliteSocialStore}from ${JSON.stringify(module)};const store=new SqliteSocialStore(process.argv[1]);await store.load();const job=await store.claimLearning(${JSON.stringify(input)});${running?`await store.updateLearningClaim(job.id,job.claim.id,'preparing',d=>{d.cognition.jobs[0].state='running';d.cognition.scopes[${JSON.stringify(message.chat)}]={cursor:100,cursorIds:[1],lastAttempt:Date.now()};});`:''}process.exit(42);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);const recovered=keep(new SqliteSocialStore(path));await recovered.load();const state=recovered.view('cognition').cognition;assert.equal(state.jobs[0].state,running?'unknown':'failed');assert.equal(state.scopes[message.chat]?.cursor,running?100:undefined);
  assert.equal(Boolean(await recovered.claimLearning(claim())),!running);
}));

test('schema 6 升级保留整理状态、游标与凭证，领取查询使用会话/状态索引',()=>fixture(async({path,store,keep})=>{
  const job=await store.claimLearning(claim());await store.updateLearningClaim(job.id,job.claim.id,'preparing',d=>{d.cognition.jobs[0].state='completed';d.cognition.scopes[message.chat]={cursor:100,cursorIds:[1],lastAttempt:100};});await store.close();
  const old=new DatabaseSync(path+'.sqlite');try{old.exec('DROP INDEX learning_chat_state;PRAGMA user_version=6;');}finally{old.close();}
  const upgraded=keep(new SqliteSocialStore(path));await upgraded.load();const state=upgraded.view('cognition').cognition;assert.equal(state.jobs[0].claim.id,job.claim.id);assert.equal(state.jobs[0].state,'completed');assert.equal(state.scopes[message.chat].cursor,100);await upgraded.close();
  const db=new DatabaseSync(path+'.sqlite',{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);assert.match(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM entity_learning_jobs WHERE chat=? AND state IN ('preparing','running') LIMIT 1").all(message.chat)),/learning_chat_state/);}finally{db.close();}
}));

test('学习发送完整原文和记忆；材料超限在模型前拒绝，不截断末尾的否定或推进游标',()=>fixture(async({store,usage,s})=>{
  const messages=Array.from({length:4},(_,i)=>({...message,id:10+i,text:'背景'.repeat(6000)+'。这只是举例，不能当成我本人的喜好。'})),memory={id:'full-memory',chat:message.chat,user:'20001',name:'甲',text:'保留'.repeat(800)+'。最后这段并非事实。',at:Date.now()};
  for(const row of messages)await store.add(row);await store.update(d=>{d.memories.push(memory);});
  let calls=0,captured,budget;const http=createServer(async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);calls++;captured=JSON.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[0].content);res.setHeader('content-type','application/json');res.end(JSON.stringify({content:[{type:'text',text:JSON.stringify({memories:[],lexicon:[]})}],usage:{input_tokens:5,output_tokens:2}}));});http.listen(0,'127.0.0.1');await once(http,'listening');
  try{
    s.requests.maxRequestKiB=64;budget=new RequestBudget(usage,()=>s);const model=learningModel({BOT_CHAT_MODE:'profile',BOT_LEARNING_API_KEY:'local-fixture',BOT_LEARNING_BASE_URL:`http://127.0.0.1:${http.address().port}`,BOT_LEARNING_MODEL:'test'},input=>budget.prepareService(input,{chat:message.chat,user:'background',background:true,signal:input.signal,allowed:()=>true}));
    const service=new Cognition(store,()=>s,usage,model.analyze,model.available,Date.now,model.prepare),batch=()=>({chat:message.chat,messages,memories:[memory],revision:cognitionRevision(store.view('memories','cognition'),message.chat)});
    await assert.rejects(service.run(batch(),signal()),/材料|大小/);assert.equal(calls,0);assert.equal(usage.used('learning'),0);assert.equal(store.view('cognition').cognition.scopes[message.chat],undefined);assert.equal(store.view('cognition').cognition.jobs.length,0);
    s.requests.maxRequestKiB=256;assert.equal(await service.run(batch(),signal()),true);assert.equal(calls,1);assert.deepEqual(captured.messages.map(row=>[row.text.length,digest(row.text)]),messages.map(row=>[row.text.length,digest(row.text)]));assert.equal(digest(captured.memories[0].text),digest(memory.text));assert.equal(usage.used('learning'),1);assert.equal(usage.used('service-requests'),1);
  }finally{budget?.close();http.closeAllConnections();await new Promise(done=>http.close(done));}
}));

test('分析等待期间只修改问号等标点也改变修订号，旧提案必须丢弃',()=>fixture(async({store,usage,s,batch})=>{
  await store.update(d=>{d.memories.push({id:'existing',chat:message.chat,user:'20001',name:'甲',text:'另一条记忆？',at:Date.now()});});let release,entered;const gate=new Promise(done=>{release=done;}),ready=new Promise(done=>{entered=done;});const before=batch().revision;
  const service=new Cognition(store,()=>s,usage,async()=>{entered();await gate;return {memories:[{user:'20001',text:message.text,evidence:[{messageId:1,quote:message.text}]}],lexicon:[]};}),task=service.run(batch(),signal());await ready;await store.update(d=>{d.memories[0].text='另一条记忆。';});assert.notEqual(before,batch().revision);release();await task;
  assert.equal(store.view('memories').memories.length,1);assert.equal(store.view('cognition').cognition.jobs[0].state,'discarded');
}));
