import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {entityTables} from '../dist/storage/database-types.js';
import {mediaNames,MEDIA_REFERENCE_LIMITS} from '../dist/storage/media-reference-types.js';
import {withOperation} from '../dist/core/operation-context.js';
import {MediaService} from '../dist/services/media.js';
import {MediaReferenceMaintenance} from '../dist/services/media-reference-maintenance.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {emptySocialData} from '../dist/storage/social-entities.js';

const name=(i=1)=>i.toString(16).padStart(64,'0')+'.png';
const message=(id,extra={})=>({chat:'private:2',id,user:2,name:'好友',at:Date.now(),text:'图片',segments:[{type:'image',data:{file:name(id)}}],self:false,recalled:false,...extra});
const record=(extra={})=>({id:randomUUID(),turn:randomUUID(),account:1,chat:'private:2',user:'2',origin:'message',tool:'qq_send_file',payload:{source:name()},summary:'文件动作',...extra});
const quotas=()=>[{key:'social-actions',amount:1,limit:100,label:'QQ 动作'}];
async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'qq-media-references-')),resources=[],keep=item=>{resources.push(item);return item;};
  try{await run({root,path:join(root,'social.json'),usagePath:join(root,'usage.json'),keep});}
  finally{for(const item of resources)await item.close?.();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}
const query=(store,names)=>store.call({action:'media-refs-query',names});
async function backfill(store){
  let processed=0,calls=0;
  for(;;){const result=await store.call({action:'media-refs-backfill'});assert.ok(result.processed<=MEDIA_REFERENCE_LIMITS.batch);processed+=result.processed;if(result.ready)return {processed,calls:calls+1};assert.ok(++calls<1000,'回填必须最终收敛');}
}
function legacy(path,fn=()=>{}){
  const db=new DatabaseSync(path+'.sqlite');
  try{
    db.exec('BEGIN');
    for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'media_refs_%'").all())db.exec(`DROP TRIGGER "${row.name}";`);
    db.exec("DROP TABLE media_references;DELETE FROM runtime_meta WHERE key LIKE 'media_refs_%';PRAGMA user_version=8;");fn(db);db.exec('COMMIT');
  }finally{db.close();}
}
async function mutate(client,changes,messages){const {revision}=await client.call({action:'metadata'});return client.call({action:'mutate',expectedRevision:revision,changes,...(messages?{messages}:{})});}

test('媒体名提取规范大小写、去重并保护旧视频帧及正文提及，拒绝单记录溢出',()=>{
  const upper='A'.repeat(64)+'.PNG',frame='b'.repeat(64)+'-01.jpg';
  assert.deepEqual(mediaNames(JSON.stringify({file:'D:\\media\\'+upper,uri:'file:///media/'+upper,note:frame})),[upper.toLowerCase(),frame]);
  assert.deepEqual(mediaNames(['a'.repeat(65)+'.png','a'.repeat(32)+'.png','a'.repeat(64)+'.abcdefghijkl','user.txt'].join(' ')),[]);
  assert.equal(mediaNames(Array.from({length:256},(_,i)=>name(i)).join(' ')).length,256);
  assert.throws(()=>mediaNames(Array.from({length:257},(_,i)=>name(i)).join(' ')),{code:'DATABASE_STATE_LIMIT'});
});

test('全部业务表引用与正文共同事务替换/删除，独立来源共享文件时保留其余引用',()=>fixture(async({path,keep})=>{
  const social=keep(new SqliteSocialStore(path));await social.load();await social.close();
  const client=keep(new DatabaseClient(path+'.sqlite'));
  for(const table of entityTables){
    await mutate(client,[{table,key:'reference-fixture',ordinal:1,value:{file:name(),nested:{cachePath:name(2)}}}]);
    assert.deepEqual(new Set((await query(client,[name(),name(2)])).names),new Set([name(),name(2)]));
  }
  assert.equal((await client.call({action:'media-refs-status'})).references,entityTables.length*2);
  for(const table of entityTables)await mutate(client,[{table,key:'reference-fixture'}]);
  assert.equal((await client.call({action:'media-refs-status'})).references,0);
  await mutate(client,[{table:'stickers',key:'one',value:{file:name()}},{table:'tasks',key:'two',value:{text:name()}}]);
  await mutate(client,[{table:'stickers',key:'one',value:{file:name(2)}}]);
  assert.equal((await client.call({action:'media-refs-status'})).references,2);
  assert.deepEqual(new Set((await query(client,[name(),name(2)])).names),new Set([name(),name(2)]));
  await mutate(client,[{table:'tasks',key:'two'}]);assert.deepEqual((await query(client,[name(),name(2)])).names,[name(2)]);
}));

test('真实社交仓储的 QQ 收藏缓存、待执行提醒及消息引用随业务保存并在重启后保留',()=>fixture(async({path,keep})=>{
  const social=keep(new SqliteSocialStore(path));await social.load();
  await social.update(d=>{d.stickers.push({id:'favorite',file:name(),note:'收藏',tags:[],uses:0,at:1,qqPresent:true,qq:{resId:'real-ref',emojiId:'1',md5:'a'.repeat(32),url:'',cachePath:name(2),description:'收藏'}});d.tasks.push({id:'task',chat:'private:2',creator:'2',text:'稍后发送 '+name(3),due:Date.now()+3600000,interval:0,state:'pending',error:'',retryAt:0});});
  await social.add(message(4));await social.close();const restored=keep(new SqliteSocialStore(path));await restored.load();
  await backfill(restored.mediaReferenceStore);const result=await query(restored.mediaReferenceStore,[1,2,3,4].map(name));assert.equal(result.ready,true);assert.equal(result.names.length,4);
  await restored.update(d=>{d.stickers=[];d.tasks=[];});assert.deepEqual((await query(restored.mediaReferenceStore,[1,2,3,4].map(name))).names,[name(4)]);
}));

test('消息重复插入不替换引用，显式修改及容量/保留期淘汰不会遗留引用',()=>fixture(async({path,keep})=>{
  const store=keep(new SqliteSocialStore(path));await store.load();await store.add(message(-1,{segments:[{type:'image',data:{file:name()}}]}));
  assert.equal(await store.add(message(-1,{segments:[{type:'image',data:{file:name(2)}}]})),false);
  assert.deepEqual((await query(store.mediaReferenceStore,[name(),name(2)])).names,[name()]);
  await store.updateWithMessages('private:2',[-1],d=>{d.messages[0].segments[0].data.file=name(2);});
  assert.deepEqual((await query(store.mediaReferenceStore,[name(),name(2)])).names,[name(2)]);
  await store.add(message(3),30,1);assert.deepEqual((await query(store.mediaReferenceStore,[name(2),name(3)])).names,[name(3)]);
  await store.add(message(4,{at:Date.now()-32*86400000}),30,10);assert.deepEqual((await query(store.mediaReferenceStore,[name(3),name(4)])).names,[name(3)]);
}));

test('schema 8 原子升级，历史回填有界可重启，新写入/替换/删除不会被旧游标覆盖',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteSocialStore(path));await seed.load();for(let i=1;i<=150;i++)await seed.add(message(i));await seed.close();legacy(path);
  const a=keep(new DatabaseClient(path+'.sqlite'));assert.equal((await query(a,[name()])).ready,false);assert.equal((await query(a,[name()])).names.length,0);
  const first=await a.call({action:'media-refs-backfill'});assert.equal(first.ready,false);assert.ok(first.processed>0&&first.processed<=64);
  const db=new DatabaseSync(path+'.sqlite',{readOnly:true});let progress;try{progress=db.prepare("SELECT value FROM runtime_meta WHERE key='media_refs_progress'").get().value;assert.equal(db.prepare('PRAGMA user_version').get().user_version,9);}finally{db.close();}
  await a.close();const b=keep(new DatabaseClient(path+'.sqlite'));
  const check=new DatabaseSync(path+'.sqlite',{readOnly:true});try{assert.equal(check.prepare("SELECT value FROM runtime_meta WHERE key='media_refs_progress'").get().value,progress);}finally{check.close();}
  await mutate(b,[{table:'stickers',key:'new-behind-cursor',value:{file:name(900)}}],[message(1,{segments:[{type:'image',data:{file:name(901)}}]})]);
  const rest=await backfill(b);assert.ok(rest.calls>1);const result=await query(b,[name(),name(2),name(900),name(901)]);assert.equal(result.ready,true);assert.deepEqual(new Set(result.names),new Set([name(2),name(900),name(901)]));
  assert.equal((await b.call({action:'media-refs-status'})).references,151);assert.deepEqual(await backfill(b),{processed:0,calls:1});
  await mutate(b,[{table:'stickers',key:'new-behind-cursor'}]);assert.deepEqual((await query(b,[name(900)])).names,[]);
}));

test('实际回填宿主退出后只续跑已提交游标，历史引用不丢失且数量不重复累加',()=>fixture(async({path,root,keep})=>{
  const seed=keep(new SqliteSocialStore(path));await seed.load();for(let i=1;i<=130;i++)await seed.add(message(i));await seed.close();legacy(path);
  const module=pathToFileURL(resolve('dist/storage/database-client.js')).href,script=join(root,'backfill-crash.mjs');
  await writeFile(script,`import{DatabaseClient}from ${JSON.stringify(module)};const client=new DatabaseClient(${JSON.stringify(path+'.sqlite')});await client.call({action:'media-refs-backfill'});process.exit(42);`);
  const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
  const resumed=keep(new DatabaseClient(path+'.sqlite')),before=await resumed.call({action:'media-refs-status'});assert.equal(before.ready,false);assert.ok(before.references>0&&before.references<=64);await backfill(resumed);assert.deepEqual(await resumed.call({action:'media-refs-status'}),{ready:true,references:130});
}));

test('初次 JSON 导入同步建立引用，完成回填后不重复计数，原文件保留',()=>fixture(async({path,keep})=>{
  const raw=JSON.stringify({...emptySocialData(),version:1,messages:[message(1),message(2)],stickers:[{id:'old',file:name(3),note:'旧收藏',tags:[],uses:0,at:1}]});await writeFile(path,raw);
  const social=keep(new SqliteSocialStore(path));await social.load();assert.equal((await social.mediaReferenceStore.call({action:'media-refs-status'})).references,3);await backfill(social.mediaReferenceStore);assert.equal((await social.mediaReferenceStore.call({action:'media-refs-status'})).references,3);assert.equal(await readFile(path,'utf8'),raw);
}));

test('单记录超限使正文和整个引用事务回滚，索引继续可用',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteSocialStore(path));await seed.load();await seed.close();const client=keep(new DatabaseClient(path+'.sqlite'));
  await mutate(client,[{table:'stickers',key:'original',value:{file:name()}}]);const before=await client.call({action:'metadata'});
  await assert.rejects(mutate(client,[{table:'tasks',key:'earlier',value:{text:name(2)}},{table:'stickers',key:'original',value:{files:Array.from({length:257},(_,i)=>name(i+10))}}]),{code:'DATABASE_STATE_LIMIT'});
  assert.deepEqual(await client.call({action:'metadata'}),before);assert.equal((await client.call({action:'media-refs-status'})).references,1);assert.deepEqual((await query(client,[name(),name(2)])).names,[name()]);
}));

test('索引总量边界拒绝新引用，但允许同量替换和释放；回填失败不提前开放清理',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteSocialStore(path));await seed.load();await seed.close();const client=keep(new DatabaseClient(path+'.sqlite'));
  await mutate(client,[{table:'stickers',key:'original',value:{file:name()}}]);
  // Set the maintained counter at its boundary without creating a million fixture rows.
  const db=new DatabaseSync(path+'.sqlite');try{db.prepare("UPDATE runtime_meta SET value=? WHERE key='media_refs_count'").run(String(MEDIA_REFERENCE_LIMITS.total));}finally{db.close();}
  await assert.rejects(mutate(client,[{table:'tasks',key:'extra',value:{text:name(2)}}]),{code:'DATABASE_STATE_LIMIT'});
  await mutate(client,[{table:'stickers',key:'original',value:{file:name(2)}}]);assert.equal((await client.call({action:'media-refs-status'})).references,MEDIA_REFERENCE_LIMITS.total);
  await mutate(client,[{table:'stickers',key:'original'}]);assert.equal((await client.call({action:'media-refs-status'})).references,MEDIA_REFERENCE_LIMITS.total-1);await client.close();
  legacy(path,db=>db.prepare('INSERT INTO entity_stickers(key,ordinal,chat,at,state,due,retry_at,payload) VALUES(?,0,\'\',0,\'\',0,0,?)').run('oversized',JSON.stringify({files:Array.from({length:257},(_,i)=>name(i))})));
  const resumed=keep(new DatabaseClient(path+'.sqlite'));await assert.rejects(resumed.call({action:'media-refs-backfill'}),{code:'DATABASE_STATE_LIMIT'});assert.deepEqual(await resumed.call({action:'media-refs-status'}),{ready:false,references:0});
}));

test('动作参数、步骤及返回文件保护活动/未知结果；已完成或未提交失败释放动作保护',()=>fixture(async({usagePath,keep})=>{
  const usage=keep(new SqliteDailyUsageStore(usagePath));await usage.load();const r=record();await usage.beginOperation(r);
  await usage.reserveOperation(r.id,0,quotas);await usage.submitOperation(r.id,0,'upload_private_file',{file:name(2)});
  await usage.finishOperationStep(r.id,0,'completed',{file:name(3)});assert.equal((await query(usage.mediaReferenceStore,[1,2,3].map(name))).names.length,3);
  await usage.completeOperation(r.id,{file:name(4)});assert.deepEqual((await query(usage.mediaReferenceStore,[1,2,3,4].map(name))).names,[]);
  const unknown=record({payload:{source:name(5)}});await usage.beginOperation(unknown);await usage.reserveOperation(unknown.id,0,quotas);await usage.submitOperation(unknown.id,0,'upload_private_file',{file:name(6)});await usage.finishOperationStep(unknown.id,0,'unknown',{file:name(7)},'响应丢失');
  assert.equal((await query(usage.mediaReferenceStore,[5,6,7].map(name))).names.length,3);
  const failed=record({payload:{source:name(8)}});await usage.beginOperation(failed);await usage.failOperation(failed.id,'提交前取消');assert.deepEqual((await query(usage.mediaReferenceStore,[name(8)])).names,[]);
  await usage.close();const reopened=keep(new SqliteDailyUsageStore(usagePath));await reopened.load();await backfill(reopened.mediaReferenceStore);assert.equal((await query(reopened.mediaReferenceStore,[5,6,7].map(name))).names.length,3);
}));

test('真实媒体保存绑定当前动作，动态生成文件在中断恢复为未知后仍保护，伪造持有者不能登记',()=>fixture(async({root,usagePath,keep})=>{
  const usage=keep(new SqliteDailyUsageStore(usagePath));await usage.load();const r=record({payload:{text:'新材料'}});await usage.beginOperation(r);
  const media=new MediaService(join(root,'media'),()=>DEFAULT_SETTINGS.social,undefined,{index:usage.mediaCacheStore,pin:file=>usage.pinMedia(basename(file))});
  const scope={record:r,owner:usage.instanceId,quotaSequence:0,stepSequence:0,signal:new AbortController().signal,authorize:()=>{}};
  const file=await withOperation(scope,()=>media.save(Buffer.from('new file'),'.txt'));assert.deepEqual((await query(usage.mediaReferenceStore,[basename(file)])).names,[basename(file)]);
  const pin={action:'media-refs-pin',name:name(),operationId:r.id,owner:'forged'};await assert.rejects(usage.mediaReferenceStore.call(pin),{code:'DATABASE_MEDIA_INVALID'});
  await usage.close();const reopened=keep(new SqliteDailyUsageStore(usagePath));await reopened.load();assert.equal((await reopened.operation(r.id)).state,'unknown');assert.deepEqual((await query(reopened.mediaReferenceStore,[basename(file)])).names,[basename(file)]);
  await assert.rejects(reopened.mediaReferenceStore.call({...pin,owner:usage.instanceId}),{code:'DATABASE_MEDIA_INVALID'});
}));

test('旧动作回填保留未知步骤文件，过期整理只级联删除已核对动作的引用',()=>fixture(async({usagePath,keep})=>{
  let now=new Date('2026-01-01T00:00:00Z');const usage=keep(new SqliteDailyUsageStore(usagePath,()=>now));await usage.load();
  const done=record(),unknown=record({payload:{source:name(2)}});await usage.beginOperation(done);await usage.reserveOperation(done.id,0,quotas);await usage.submitOperation(done.id,0,'upload_private_file',{file:name(3)});await usage.finishOperationStep(done.id,0,'completed',{file:name(4)});await usage.completeOperation(done.id,{file:name(5)});
  await usage.beginOperation(unknown);await usage.reserveOperation(unknown.id,0,quotas);await usage.submitOperation(unknown.id,0,'upload_private_file',{file:name(6)});await usage.failOperation(unknown.id,'响应未知');await usage.close();legacy(usagePath);
  const restored=keep(new SqliteDailyUsageStore(usagePath,()=>now));await restored.load();await backfill(restored.mediaReferenceStore);assert.deepEqual(new Set((await query(restored.mediaReferenceStore,[1,2,3,4,5,6].map(name))).names),new Set([name(2),name(6)]));
  now=new Date('2026-03-01T00:00:00Z');await restored.beginOperation(record({payload:{text:'触发整理'}}));assert.equal(await restored.operation(done.id),null);assert.equal((await restored.operation(unknown.id)).state,'unknown');
  const db=new DatabaseSync(usagePath+'.sqlite',{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_references WHERE operation_id=?').get(done.id).n,0);assert.equal(db.prepare("SELECT value FROM runtime_meta WHERE key='media_refs_count'").get().value,'2');}finally{db.close();}
}));

test('引用查询限制有效文件名和批量范围，未知维护动作不能推进回填',()=>fixture(async({path,keep})=>{
  const seed=keep(new SqliteSocialStore(path));await seed.load();await seed.close();const client=keep(new DatabaseClient(path+'.sqlite'));
  for(const names of [null,[null],['../'+name()],[name()+'.bad'],Array.from({length:101},()=>name())])await assert.rejects(query(client,names),{code:'DATABASE_MEDIA_INVALID'});
  await assert.rejects(client.call({action:'media-refs-invalid'}),{code:'DATABASE_MEDIA_INVALID'});assert.equal((await client.call({action:'media-refs-status'})).ready,false);
  await mutate(client,[{table:'stickers',key:'upper',value:{file:'A'.repeat(64)+'.PNG'}}]);assert.deepEqual((await query(client,['A'.repeat(64)+'.PNG','a'.repeat(64)+'.png'])).names,['a'.repeat(64)+'.png']);
}));

test('后台回填跳过前台忙碌/停止，轮转两个仓储且只对未就绪仓储继续处理',async()=>{
  let now=0,busy=true,stopping=false;const calls=[],stores=[0,1].map(index=>({call:async r=>{assert.equal(r.action,'media-refs-backfill');calls.push(index);return {ready:index===1||calls.filter(i=>i===0).length===2};}}));
  const maintenance=new MediaReferenceMaintenance(stores,{busy:()=>busy,stopping:()=>stopping,now:()=>now,onFailure:error=>{throw error;}});
  await maintenance.tick();assert.deepEqual(calls,[]);busy=false;await maintenance.tick();await maintenance.tick();assert.deepEqual(calls,[0]);now=1000;await maintenance.tick();now=2000;await maintenance.tick();now=3000;await maintenance.tick();assert.deepEqual(calls,[0,1,0]);
  const stopped=new MediaReferenceMaintenance(stores,{busy:()=>false,stopping:()=>true,onFailure:()=>assert.fail()});await stopped.tick();assert.equal(calls.length,3);await maintenance.flush();
});

test('后台维护同一时刻仅一批，停止排空等待在途请求，失败上报且不假报已就绪',async()=>{
  let release,failures=0,calls=0,stopping=false,now=0;const gate=new Promise(done=>release=done),store={call:async()=>{calls++;await gate;throw new Error('worker failed');}};
  const maintenance=new MediaReferenceMaintenance([store],{busy:()=>false,stopping:()=>stopping,now:()=>now,onFailure:error=>{assert.match(error.message,/worker failed/);failures++;}});
  const running=maintenance.tick();await maintenance.tick();assert.equal(calls,1);stopping=true;let flushed=false;const flush=maintenance.flush().then(()=>flushed=true);await Promise.resolve();assert.equal(flushed,false);release();await Promise.all([running,flush]);assert.equal(failures,1);await maintenance.tick();assert.equal(calls,1);stopping=false;now=1000;await maintenance.tick();assert.equal(calls,2);assert.equal(failures,2);
});
