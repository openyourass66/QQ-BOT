import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {SqliteSessionStore,SqliteGroupContextStore} from '../dist/storage/sqlite-runtime-stores.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-runtime-db-'));const stores=[];try{await run({root,keep:store=>{stores.push(store);return store;}});}finally{await Promise.allSettled(stores.map(store=>store.close()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const entry=(id,extra={})=>({seq:id,messageId:id,userId:2,name:'用户',text:'内容'+id,role:'user',at:100,...extra});
const record=(id,extra={})=>({messageId:id,userId:2,name:'用户',text:'内容'+id,role:'user',...extra});
const rows=path=>{const db=new DatabaseSync(path+'.sqlite',{readOnly:true});try{return Object.fromEntries(db.prepare('SELECT key,payload FROM entity_state ORDER BY ordinal,key').all().map(row=>[row.key,JSON.parse(row.payload)]));}finally{db.close();}};
const groupRows=path=>{const records=rows(path),groups=Object.fromEntries(records.$groups.keys.map(key=>[key,[]]));for(const row of Object.entries(records).filter(([key])=>key!=='$groups').map(([,value])=>value).sort((a,b)=>a.position-b.position))groups[row.group].push(row.entry);return groups;};

test('映射完整迁移并持续增量写入，旧原文与备份保留，重启维持策略和代次',()=>fixture(async({root,keep})=>{
  const path=join(root,'custom-sessions.json'),original=JSON.stringify({version:1,sessions:{'private:2':{sessionId:'old',updatedAt:1,policy:'saved policy',generation:3}}});await writeFile(path,original);
  const store=keep(new SqliteSessionStore(path));await store.load();assert.equal(store.metadata('private:2').generation,3);
  for(let id=0;id<500;id++){store.set('group:'+id,'session-'+id,'policy',2);if(id%50===0)await Promise.resolve();}store.delete('group:1');await store.flush();
  assert.equal(await readFile(path,'utf8'),original);const backup=(await readdir(root)).find(name=>name.startsWith('custom-sessions.json.pre-sqlite-'));assert.equal(await readFile(join(root,backup),'utf8'),original);
  await store.close();const recovered=keep(new SqliteSessionStore(path));await recovered.load();assert.equal(recovered.get('private:2'),'old');assert.equal(recovered.get('group:1'),undefined);assert.equal(recovered.get('group:499'),'session-499');assert.equal(recovered.list().length,500);assert.deepEqual(recovered.metadata('private:2'),{sessionId:'old',updatedAt:1,policy:'saved policy',generation:3});
}));

test('群上下文迁移保留顺序和引用，排队不读未来消息，过期与容量清理落盘',()=>fixture(async({root,keep})=>{
  const path=join(root,'groups.json'),original=JSON.stringify({version:1,groups:{'1:10':[entry(1),entry(2,{role:'assistant',replyTo:1,targetUserId:2})]}});await writeFile(path,original);let now=200;
  const store=keep(new SqliteGroupContextStore(path,()=>now));await store.load();assert.equal(store.find(1,10,2).targetUserId,2);assert.equal(store.hasReply(1,10,1),true);
  const first=store.record(1,10,record(3)),second=store.record(1,10,record(4));store.record(1,10,record(5,{role:'assistant',replyTo:first.seq,targetUserId:2}));store.record(1,10,record(6));
  assert.deepEqual(store.context(1,10,second.seq,80).map(item=>item.messageId),[1,2,3,5]);await store.flush();assert.equal(await readFile(path,'utf8'),original);
  await store.close();const recovered=keep(new SqliteGroupContextStore(path,()=>now));await recovered.load();assert.equal(recovered.hasReply(1,10,first.seq),true);assert.equal(recovered.canFollowUp(1,10,2,90000),true);
  for(let id=0;id<90;id++)recovered.record(1,11,record(id));assert.equal(recovered.context(1,11,10000,1000).length,80);
  for(let group=12;group<113;group++)recovered.record(1,group,record(group));await recovered.flush();assert.equal(Object.keys(groupRows(path)).length,100);assert.equal(recovered.find(1,10,3),undefined);
  now+=86400001;recovered.record(1,200,record(200));await recovered.flush();assert.deepEqual(Object.keys(groupRows(path)),['1:200']);recovered.clear(1,200);await recovered.flush();assert.deepEqual(groupRows(path),{});
}));

test('修改一个群或映射不重写其他正文，两个写入者发生修订冲突时不覆盖',()=>fixture(async({root,keep})=>{
  const path=join(root,'groups.json'),store=keep(new SqliteGroupContextStore(path,()=>100));await store.load();store.record(1,10,record(1));store.record(1,11,record(2));await store.flush();
  const db=new DatabaseSync(path+'.sqlite');db.exec("CREATE TRIGGER protect_other BEFORE UPDATE ON entity_state WHEN OLD.key='1:11/2' BEGIN SELECT RAISE(ABORT,'other row rewritten'); END;");db.close();
  store.record(1,10,record(3));await store.flush();assert.equal(groupRows(path)['1:11'][0].text,'内容2');
  const stale=keep(new SqliteGroupContextStore(path,()=>100));await stale.load();store.record(1,10,record(4));await store.flush();let failed;stale.onFailure=error=>{failed=error;};stale.record(1,10,record(5));await assert.rejects(stale.flush(),{code:'DATABASE_REVISION_CONFLICT'});assert.equal(failed.code,'DATABASE_REVISION_CONFLICT');assert.equal(groupRows(path)['1:10'].some(item=>item.messageId===5),false);
}));

test('损坏、超容量、源文件变动和类型误配保留原文件，不把数据当空记录',()=>fixture(async({root,keep})=>{
  const broken=join(root,'broken.json');await writeFile(broken,'{broken');await assert.rejects(keep(new SqliteSessionStore(broken)).load(),/损坏/);assert.equal(await readFile(broken,'utf8'),'{broken');assert.equal((await readdir(root)).includes('broken.json.sqlite'),false);
  const large=join(root,'large.json'),groups=Object.fromEntries(Array.from({length:101},(_,i)=>['1:'+i,[entry(i+1)]]));await writeFile(large,JSON.stringify({version:1,groups}));await assert.rejects(keep(new SqliteGroupContextStore(large)).load(),/超过支持容量/);assert.equal((await readdir(root)).includes('large.json.sqlite'),false);
  const path=join(root,'sessions.json'),store=keep(new SqliteSessionStore(path));await writeFile(path,'{"version":1,"sessions":{}}');await store.load();store.set('private:2','session');await store.flush();await store.close();await writeFile(path,'{"version":1,"sessions":{"changed":{"sessionId":"other","updatedAt":1}}}');await assert.rejects(keep(new SqliteSessionStore(path)).load(),error=>error.code==='DATABASE_SOURCE_CHANGED'&&error.message.includes(path));assert.equal(rows(path)['private:2'].sessionId,'session');
  const wrong=join(root,'wrong-groups.json');await copyFile(path+'.sqlite',wrong+'.sqlite');await assert.rejects(keep(new SqliteGroupContextStore(wrong)).load(),/类型或迁移状态/);
}));

test('迁移宿主中断不激活半成品，重启完整迁移全部会话',()=>fixture(async({root,keep})=>{
  const path=join(root,'sessions.json'),sessions=Object.fromEntries(Array.from({length:600},(_,i)=>['private:'+i,{sessionId:'session-'+i,updatedAt:i,policy:'p',generation:2}])),raw=JSON.stringify({version:1,sessions});await writeFile(path,raw);
  const client=pathToFileURL(resolve('dist/storage/database-client.js')).href,runtime=pathToFileURL(resolve('dist/storage/sqlite-runtime-stores.js')).href;
  const script=`import {DatabaseClient} from ${JSON.stringify(client)};import {SqliteSessionStore} from ${JSON.stringify(runtime)};const original=DatabaseClient.prototype.call;DatabaseClient.prototype.call=async function(request){const result=await original.call(this,request);if(request.action==='import')process.exit(42);return result;};await new SqliteSessionStore(process.argv[1]).load();`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);assert.equal((await readdir(root)).includes('sessions.json.sqlite'),false);assert.equal(await readFile(path,'utf8'),raw);
  const recovered=keep(new SqliteSessionStore(path));await recovered.load();assert.equal(recovered.list().length,600);assert.equal(recovered.metadata('private:599').generation,2);assert.equal(rows(path)['private:599'].sessionId,'session-599');
}));

test('每群保留八十条时只增删一条，不重写其余七十九条正文',()=>fixture(async({root,keep})=>{
  const path=join(root,'groups.json'),store=keep(new SqliteGroupContextStore(path,()=>100));await store.load();for(let id=1;id<=80;id++)store.record(1,10,record(id));await store.flush();
  const db=new DatabaseSync(path+'.sqlite');db.exec("CREATE TABLE audit(action TEXT);CREATE TRIGGER count_insert AFTER INSERT ON entity_state BEGIN INSERT INTO audit VALUES('insert');END;CREATE TRIGGER count_delete AFTER DELETE ON entity_state BEGIN INSERT INTO audit VALUES('delete');END;CREATE TRIGGER count_update AFTER UPDATE ON entity_state BEGIN INSERT INTO audit VALUES('update');END;");
  try{store.record(1,10,record(81));await store.flush();const counts=Object.fromEntries(db.prepare('SELECT action,COUNT(*) AS n FROM audit GROUP BY action').all().map(row=>[row.action,Number(row.n)]));assert.deepEqual(counts,{delete:1,insert:1});assert.equal(groupRows(path)['1:10'].length,80);assert.equal(store.find(1,10,1),undefined);assert.equal(store.find(1,10,81).text,'内容81');}finally{db.close();}
}));

test('多批群淘汰提交后强制结束宿主，已提交数据仍可完整恢复且无孤立记录',()=>fixture(async({root,keep})=>{
  const path=join(root,'groups.json'),groups=Object.fromEntries(Array.from({length:100},(_,index)=>['1:'+(index+1),Array.from({length:80},(_,i)=>entry(i+1))]));await writeFile(path,JSON.stringify({version:1,groups}));
  const seed=keep(new SqliteGroupContextStore(path,()=>100));await seed.load();await seed.close();
  const client=pathToFileURL(resolve('dist/storage/database-client.js')).href,runtime=pathToFileURL(resolve('dist/storage/sqlite-runtime-stores.js')).href;
  const script=`import {DatabaseClient} from ${JSON.stringify(client)};import {SqliteGroupContextStore} from ${JSON.stringify(runtime)};const original=DatabaseClient.prototype.call;let committed=0;DatabaseClient.prototype.call=async function(request){const result=await original.call(this,request);if(request.action==='mutate'&&++committed===3)process.exit(42);return result;};const store=new SqliteGroupContextStore(process.argv[1],()=>100);await store.load();for(let group=101;group<=120;group++)store.record(1,group,{messageId:group,userId:2,name:'user',text:'new',role:'user'});await store.flush();`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
  const recovered=keep(new SqliteGroupContextStore(path,()=>100));await recovered.load();const actual=groupRows(path);assert.equal(Object.keys(actual).length,100);assert.ok(actual['1:101']);assert.ok(!actual['1:1']);assert.ok(Object.values(actual).every(entries=>entries.length===1||entries.length===80));
}));
