import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SocialStore} from '../dist/qq/social-store.js';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {DailyUsageStore} from '../dist/core/usage.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {Autonomy} from '../dist/agent/autonomy.js';
import {selectBackgroundThought,backgroundLane} from '../dist/app/background-selection.js';
import {DatabaseSync} from 'node:sqlite';

const thought=(id,now,extra={})=>({id,key:id,chat:'private:20001',kind:'chat',summary:'具体想法',reason:'实际依据',at:now-1000,due:now-100,expires:now+3600000,priority:50,state:'pending',result:'',...extra});
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-background-claims-')),resources=[],keep=item=>{resources.push(item);return item;};try{await run({root,path:join(root,'social.json'),keep});}finally{await Promise.allSettled(resources.map(item=>item.close?.()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}

for(const [name,Store] of [['JSON 参考',SocialStore],['SQLite',SqliteSocialStore]])test(`${name}：自主领取、到期查询和完成凭证保持同一契约`,()=>fixture(async({path,keep})=>{
  const store=keep(new Store(path)),now=Date.now();await store.load();await store.update(d=>{d.autonomous.thoughts=[thought('due',now),thought('later',now,{due:now+1000}),thought('expired',now,{expires:now-1})];});
  assert.deepEqual((await store.dueThoughts(now)).map(row=>row.id),['due']);const claimed=await store.claimThought('due',now);assert.ok(claimed.claim.id);assert.equal(await store.claimThought('due',now),undefined);
  assert.equal(await store.updateThoughtClaim('due','old',()=>{throw new Error('旧凭证进入回调');}),false);assert.equal(await store.updateThoughtClaim('due',claimed.claim.id,d=>{d.autonomous.thoughts[0].state='pending';d.autonomous.scheduleCursor='chat:private:20001';}),true);
  const next=await store.claimThought('due',now);assert.notEqual(next.claim.id,claimed.claim.id);assert.equal(await store.updateThoughtClaim('due',claimed.claim.id,d=>{d.autonomous.thoughts[0].state='done';}),false);
  assert.equal(await store.updateThoughtClaim('due',next.claim.id,d=>{d.autonomous.thoughts[0].state='done';}),true);assert.equal(await store.updateThoughtClaim('due',next.claim.id,()=>{}),false);assert.equal(await store.claimThought('expired',now),undefined);assert.equal(await store.claimThought('later',now),undefined);
}));

test('两个真实 Worker 六十四次自主领取只有一次成功，旧凭证不覆盖新状态且不推进修订',()=>fixture(async({path,keep})=>{
  const now=Date.now(),seed=keep(new SqliteSocialStore(path));await seed.load();await seed.update(d=>{d.autonomous.thoughts=[thought('one',now)];});await seed.close();
  const a=keep(new DatabaseClient(path+'.sqlite')),b=keep(new DatabaseClient(path+'.sqlite')),before=await a.call({action:'metadata'});
  const attempts=await Promise.all(Array.from({length:64},(_,i)=>(i%2?a:b).call({action:'claim-thought',expectedRevision:before.revision,id:'one',claimId:randomUUID(),owner:'worker-'+i,now}))),winners=attempts.filter(row=>row.claimed);assert.equal(winners.length,1);
  const winner=winners[0],row=(await a.call({action:'metadata'})).rows.find(row=>row.table==='thoughts'),finish=(claimId,revision,state)=>a.call({action:'mutate',expectedRevision:revision,guard:{table:'thoughts',key:'one',claimId},changes:[{...row,value:{...winner.thought,state}}]});
  const wrong=await finish('wrong',before.revision,'done');assert.equal(wrong.changed,false);assert.equal(wrong.revision,winner.revision);
  const delayed=await finish(winner.thought.claim.id,winner.revision,'pending');assert.equal(delayed.changed,true);const next=await b.call({action:'claim-thought',expectedRevision:delayed.revision,id:'one',claimId:randomUUID(),owner:'next',now});
  const stale=await finish(winner.thought.claim.id,delayed.revision,'done');assert.equal(stale.changed,false);assert.equal(stale.revision,next.revision);assert.equal((await a.call({action:'metadata'})).rows.find(row=>row.table==='thoughts').value.claim.id,next.thought.claim.id);
}));

test('领取宿主强制结束后恢复为未知，保留凭证与轮转位置且不自动重领',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteSocialStore(path)),now=Date.now();await seed.load();await seed.update(d=>{d.autonomous.thoughts=[thought('crash',now)];d.autonomous.scheduleCursor='collect:private:20001';});await seed.close();
  const module=pathToFileURL(resolve('dist/storage/sqlite-social-store.js')).href,script=`import{SqliteSocialStore}from ${JSON.stringify(module)};const store=new SqliteSocialStore(process.argv[1]);await store.load();await store.claimThought('crash',Date.now());process.exit(42);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
  const recovered=keep(new SqliteSocialStore(path));await recovered.load();const state=recovered.view('autonomous').autonomous;assert.equal(state.thoughts[0].state,'unknown');assert.ok(state.thoughts[0].claim.id);assert.equal(state.scheduleCursor,'collect:private:20001');assert.equal(await recovered.claimThought('crash',now),undefined);assert.deepEqual(await recovered.dueThoughts(now),[]);
}));

test('前台取消发生在后台唤醒等待期间时，晚到完成不追加决策或覆盖取消；旧执行凭证拒绝',()=>fixture(async({root,path,keep})=>{
  const now=Date.now(),s=structuredClone(DEFAULT_SETTINGS);Object.assign(s.social,{proactiveEnabled:true,quietStartHour:0,quietEndHour:0});const store=keep(new SqliteSocialStore(path));await store.load();await store.update(d=>{d.autonomous.lastScanAt=now;d.autonomous.thoughts=[thought('cancel',now)];});
  const usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();const autonomy=new Autonomy(store,()=>s,usage,()=>now);let release,entered;const gate=new Promise(done=>{release=done;}),ready=new Promise(done=>{entered=done;});
  const task=autonomy.tick(new AbortController().signal,async(_,turn)=>{entered();await gate;turn.effects.add('chat');});await ready;
  const claimed=store.view('autonomous').autonomous.thoughts[0];assert.throws(()=>autonomy.authorize({chat:'private:20001',autonomous:{kind:'chat',thoughtId:'cancel',runId:'stale'}},'qq_reply'),/凭证已失效/);
  await store.update(d=>{d.autonomous.thoughts[0].state='dismissed';d.autonomous.thoughts[0].result='主人取消';});release();await task;
  const state=store.view('autonomous').autonomous;assert.equal(state.thoughts[0].result,'主人取消');assert.equal(state.thoughts[0].claim.id,claimed.claim.id);assert.equal(state.decisions.length,0);assert.equal(state.contacts[0].attemptAt,0);
}));

test('后台按种类与会话轮转，持续高优先级聊天不挤掉收藏/空间；轮转后保留组内优先级',()=>{
  const now=Date.now(),rows=[thought('hot',now,{priority:100}),thought('other',now,{chat:'private:20002',priority:1}),thought('collect',now,{kind:'collect',priority:1}),thought('space',now,{kind:'qzone',chat:'',priority:1}),thought('comment',now,{kind:'qzone-comment',chat:'',targetUser:20001,priority:1})];let cursor='',selected=[];
  for(let i=0;i<10;i++){const next=selectBackgroundThought(rows,cursor,now);selected.push(next.id);cursor=backgroundLane(next);}
  assert.deepEqual(selected.slice(0,5),['hot','other','collect','space','comment']);assert.deepEqual(selected.slice(5),selected.slice(0,5));assert.equal(selectBackgroundThought([],cursor,now),undefined);
  assert.equal(selectBackgroundThought([...rows,thought('higher',now,{priority:99})],'qzone-comment:20001',now).id,'hot');
  const aged=thought('aged',now,{at:now-60*3600000,priority:1});assert.equal(selectBackgroundThought([rows[0],aged],'',now).id,'aged');
});

test('schema 5 原子增加到期索引，保留想法、游标和领取记录；查询使用状态/到期索引',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteSocialStore(path)),now=Date.now();await store.load();await store.update(d=>{d.autonomous.thoughts=[thought('indexed',now)];d.autonomous.scheduleCursor='chat:private:20001';});const claimed=await store.claimThought('indexed',now);await store.updateThoughtClaim('indexed',claimed.claim.id,d=>{d.autonomous.thoughts[0].state='pending';});await store.close();
  const old=new DatabaseSync(path+'.sqlite');try{old.exec('DROP INDEX thoughts_due;PRAGMA user_version=5;');}finally{old.close();}
  const upgraded=keep(new SqliteSocialStore(path));await upgraded.load();const rows=await upgraded.dueThoughts(now);assert.equal(rows[0].claim.id,claimed.claim.id);assert.equal(upgraded.view('autonomous').autonomous.scheduleCursor,'chat:private:20001');await upgraded.close();
  const db=new DatabaseSync(path+'.sqlite',{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);const plan=db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM entity_thoughts WHERE state='pending' AND due<=? AND json_extract(payload,'$.expires')>? ORDER BY due,key LIMIT ?").all(now,now,200);assert.match(JSON.stringify(plan),/thoughts_due/);assert.doesNotMatch(JSON.stringify(plan),/TEMP B-TREE/);}finally{db.close();}
}));

test('模型队列接纳后才预扣自主判断，忙碌退回不消耗；重复预扣回调只计一次',()=>fixture(async({root,path,keep})=>{
  let now=Date.now();const s=structuredClone(DEFAULT_SETTINGS);Object.assign(s.social,{proactiveEnabled:true,quietStartHour:0,quietEndHour:0});const store=keep(new SqliteSocialStore(path));await store.load();await store.update(d=>{d.autonomous.lastScanAt=now;d.autonomous.thoughts=[thought('wait',now)];});
  const usage=new DailyUsageStore(join(root,'usage.json')),signal=new AbortController().signal;await usage.load();const autonomy=new Autonomy(store,()=>s,usage,()=>now);
  await autonomy.tick(signal,async()=>false,()=>true,undefined,true);assert.equal(usage.used('autonomous-decisions'),0);assert.equal(store.view('autonomous').autonomous.thoughts[0].state,'pending');
  now+=31000;await autonomy.tick(signal,async(_,turn)=>{await Promise.all([turn.reserveDecision(),turn.reserveDecision()]);turn.effects.add('chat');},()=>true,undefined,true);assert.equal(usage.used('autonomous-decisions'),1);assert.equal(store.view('autonomous').autonomous.thoughts[0].state,'done');
}));
