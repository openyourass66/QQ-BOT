import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SocialStore,SocialDataSchema} from '../dist/qq/social-store.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {ensureSocialDatabase} from '../dist/storage/social-migration.js';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {dataFromRows,dataFingerprint} from '../dist/storage/social-entities.js';
import {SocialEngine} from '../dist/qq/social-engine.js';
import {DailyUsageStore} from '../dist/core/usage.js';
import {validateSettings} from '../dist/core/settings.js';
import {DatabaseSync} from 'node:sqlite';
import {MemoryMetaSchema} from '../dist/agent/cognition-state.js';
import {recall} from '../dist/agent/cognition.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-sqlite-store-'));const path=join(root,'自定义 数据.json'),store=new SqliteSocialStore(path);try{await run({root,path,store});}finally{await store.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const entry=(id,chat='private:2')=>({chat,id,user:2,name:'朋友',at:Date.now()+id,text:`内容${id}`,segments:[{type:'text',data:{text:`内容${id}`}}],self:false,recalled:false});
async function exported(path){const client=new DatabaseClient(path+'.sqlite');try{const state=await client.call({action:'metadata'}),data=dataFromRows(state.rows);data.messages=(await client.call({action:'query-messages',query:{limit:20000,ascending:true}})).rows;return data;}finally{await client.close();}}

test('v1/v2 全部业务字段按条目迁移，来源与备份不变，逐条摘要一致且重复启动不再导入',()=>fixture(async({root})=>{
  for(const version of [1,2]){
    const path=join(root,`legacy-${version}.json`),legacy=new SocialStore(path);await legacy.load();
    await legacy.account(1);await legacy.add(entry(1));await legacy.addEvent('private:2','notice:test',{original:true});await legacy.addTask({chat:'private:2',creator:'2',text:'提醒',due:Date.now()+60000,interval:0});
    await legacy.beginAction('private:2','qq_reply');await legacy.update(d=>{d.actions[0].state='success';d.actions[0].summary='完成';d.memories.push({id:'memory',chat:'private:2',user:'2',name:'朋友',text:'普通记忆',at:1});d.profiles.push({chat:'private:2',persona:'专属人设',responseMode:'inherit',keywords:[],probability:10,proactive:false});d.stickers.push({id:'sticker',file:'',note:'收藏',tags:[],uses:0,at:1,qqPresent:false});d.turns.push({id:'turn',chat:'private:2',at:1,duration:1,input:'输入',output:'输出',tools:[],error:'',inputTokens:null,outputTokens:null});d.autonomous.interests.push({id:'interest',chat:'private:2',topic:'猫',reason:'交流',strength:1,at:1,updatedAt:1,source:'admin'});});
    await legacy.update(d=>{
      d.cognition.memories.memory=MemoryMetaSchema.parse({source:'learned',sources:[1],locked:false,confidence:'supported',history:[{text:'旧记忆',at:1,reason:'更正'}]});
      d.cognition.lexicon.push({id:'lexicon',chat:'group:3',term:'术语',meaning:'解释',kind:'term',sources:[1],evidence:[],status:'candidate',locked:false,revision:1,at:1,history:[]});d.cognition.suppressed.push({chat:'private:2',hash:'suppressed',at:1});d.cognition.scopes['private:2']={cursor:1,cursorIds:[1],lastAttempt:2};d.cognition.jobs.push({id:'job',chat:'private:2',at:1,state:'completed',summary:'已整理',sources:[1]});
      d.autonomous.thoughts.push({id:'thought',key:'key',chat:'private:2',kind:'chat',summary:'想法',reason:'交流',at:1,due:2,expires:3,priority:1,state:'dismissed',result:'已结束'});d.autonomous.decisions.push({id:'decision',thoughtId:'thought',chat:'private:2',kind:'chat',at:2,outcome:'dismissed',reason:'安静'});d.autonomous.contacts.push({chat:'private:2',incomingAt:1,proactiveAt:2,unanswered:1,attemptAt:3});d.autonomous.stickerUses.push(...Array.from({length:2},()=>({chat:'private:2',stickerId:'sticker',at:1})));d.autonomous.posts.push({hash:'post',at:1,state:'success',tid:'tid',summary:'正文'});d.autonomous.spaceComments.push({hash:'comment',at:1,state:'unknown'});d.autonomous.lastScanAt=123;d.autonomous.commentCursor=4;
    });
    const raw={...legacy.snapshot(),version};await writeFile(path,JSON.stringify(raw));const before=await readFile(path),stages=[];
    const migrated=new SqliteSocialStore(path,{onMigrationProgress:event=>stages.push(event.stage)});
    try{await migrated.load();assert.equal(migrated.profile('private:2').persona,'专属人设');assert.equal((await migrated.message('private:2',1)).text,'内容1');assert.equal(migrated.view('tasks').tasks.length,1);assert.equal(migrated.view('contacts').messages.length,0);assert.throws(()=>migrated.snapshot(),/快照/);}finally{await migrated.close();}
    assert.deepEqual(await readFile(path),before);assert.ok(stages.includes('verify')&&stages.includes('activate'));
    const backups=(await readdir(root)).filter(name=>name.startsWith(`legacy-${version}.json.pre-sqlite-`));assert.equal(backups.length,1);assert.deepEqual(await readFile(join(root,backups[0])),before);
    const data=await exported(path),expected=SocialDataSchema.parse({...raw,version:2});
    assert.equal(dataFingerprint(data),dataFingerprint(expected));
    const reopened=new SqliteSocialStore(path,{onMigrationProgress:()=>{throw new Error('不应重新导入');}});try{await reopened.load();assert.equal((await reopened.queryMessages({})).total,1);}finally{await reopened.close();}
  }
}));

test('增量仓储消息异步查询、来源原子修改与回滚，业务动作和提醒持久化后重启恢复',()=>fixture(async({root,path,store})=>{
  await store.load();for(let id=1;id<=6;id++)await store.add(entry(id),30,3);await store.add(entry(6));await store.add(entry(6,'group:3'));
  assert.equal((await store.queryMessages({chat:'private:2'})).total,3);assert.deepEqual((await store.messages('private:2')).map(m=>m.id),[4,5,6]);
  await assert.rejects(store.update(d=>{d.messages.push(entry(99));}),/显式/);
  await assert.rejects(store.updateWithMessages('private:2',[4],d=>{d.messages[0].recalled=true;d.contacts[0].name='失败';throw new Error('回滚');}),/回滚/);assert.equal((await store.message('private:2',4)).recalled,false);assert.notEqual(store.contacts()[0].name,'失败');
  await store.updateWithMessages('private:2',[4],d=>{d.messages[0].recalled=true;});assert.equal((await store.message('private:2',4)).recalled,true);
  const task=await store.addTask({chat:'private:2',creator:'2',text:'提醒',due:1,interval:0});await store.update(d=>{d.tasks[0].state='running';});const action=await store.beginAction('private:2','qq_reply');
  const usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();const settings=validateSettings({}),engine=new SocialEngine(store,{capabilities:()=>({})},{},usage,()=>settings,async()=>true,()=>{},()=>{});
  const found=await engine.execute({action:'social',tool:'qq_message',args:{message_id:5}},{chat:'private:2',self:1,user:2,origin:'message',signal:new AbortController().signal,sent:0,silent:false});assert.equal(found.text,'内容5');
  await store.close();const reopened=new SqliteSocialStore(path);try{await reopened.load();assert.equal(reopened.view('tasks').tasks.find(t=>t.id===task.id).state,'unknown');assert.equal(reopened.view('actions').actions.find(a=>a.id===action).state,'unknown');assert.equal((await reopened.latestIncoming()).length,2);}finally{await reopened.close();}
}));

test('迁移中断、源文件变化、过新版本、重复记录或损坏文件均保留原文，不激活半成品',()=>fixture(async({root})=>{
  for(const kind of ['interrupted','changed','newer','duplicate','broken']){
    const path=join(root,kind+'.json'),base=new SocialStore(path);await base.load();await base.add(entry(1));const raw=base.snapshot();
    if(kind==='newer')raw.version=999;if(kind==='duplicate')raw.messages.push(raw.messages[0]);await writeFile(path,kind==='broken'?'{original malformed':JSON.stringify(raw));const original=await readFile(path);let changed=false;
    await assert.rejects(ensureSocialDatabase(path,async progress=>{if(progress.stage==='import'&&kind==='interrupted')throw new Error('模拟中断');if(progress.stage==='verify'&&kind==='changed'){changed=true;await writeFile(path,original.toString()+'\n');}}));
    assert.deepEqual(await readFile(path),changed?Buffer.from(original.toString()+'\n'):original);assert.ok(!(await readdir(root)).includes(kind+'.json.sqlite'));assert.ok(!(await readdir(root)).some(name=>name.startsWith(kind+'.json.sqlite.migration-')));
    if(kind==='interrupted'){const valid=new SqliteSocialStore(path);try{await valid.load();assert.equal((await valid.queryMessages({})).total,1);}finally{await valid.close();}}
  }
}));

test('迁移后旧 JSON 被旧版本修改时拒绝继续，数据库中新增内容不被覆盖',()=>fixture(async({path,store})=>{
  const legacy=new SocialStore(path);await legacy.load();await legacy.add(entry(1));await store.load();await store.add(entry(2));await store.close();const original=await readFile(path);await writeFile(path,original.toString()+'\n');
  const stale=new SqliteSocialStore(path);try{await assert.rejects(stale.load(),/迁移后发生变化/);}finally{await stale.close();}assert.equal((await exported(path)).messages.length,2);
}));

test('清理最早轮次只写入新增条目，不重写其余 499 条正文；较早已撤回的依据仍拒绝使用',()=>fixture(async({path,store})=>{
  const legacy=new SocialStore(path);await legacy.load();
  const turn=id=>({id:String(id),chat:'private:2',at:id,duration:1,input:'x'.repeat(6000),output:'y'.repeat(6000),tools:[],error:'',inputTokens:null,outputTokens:null});
  await legacy.update(d=>{d.turns=Array.from({length:500},(_,i)=>turn(i));d.messages=Array.from({length:100},(_,id)=>({...entry(id),recalled:id===0}));d.memories.push({id:'memory',chat:'private:2',user:'2',name:'朋友',text:'已经撤回的说法',at:1});d.cognition.memories.memory=MemoryMetaSchema.parse({sources:[0],evidence:[{id:0,user:'2',quote:'原说法',at:1}],locked:true});});
  await store.load();const db=new DatabaseSync(path+'.sqlite');try{
    db.exec("CREATE TABLE write_audit(kind TEXT);CREATE TRIGGER turn_update AFTER UPDATE ON entity_turns BEGIN INSERT INTO write_audit VALUES('update');END;CREATE TRIGGER turn_insert AFTER INSERT ON entity_turns BEGIN INSERT INTO write_audit VALUES('insert');END;CREATE TRIGGER turn_delete AFTER DELETE ON entity_turns BEGIN INSERT INTO write_audit VALUES('delete');END;");
    await store.update(d=>{d.turns.push(turn(500));d.turns=d.turns.slice(-500);});
    assert.deepEqual(db.prepare('SELECT kind FROM write_audit ORDER BY kind').all().map(row=>row.kind),['delete','insert']);assert.equal(store.view('turns').turns[0].id,'1');
    assert.equal(recall(await store.context('private:2'),validateSettings({}),'private:2','2','说法').memories,'');
  }finally{db.close();}
  await store.close();const reopened=new SqliteSocialStore(path);try{await reopened.load();assert.equal(reopened.view('turns').turns.at(-1).id,'500');}finally{await reopened.close();}
}));
