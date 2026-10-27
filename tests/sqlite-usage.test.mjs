import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {DailyUsageStore} from '../dist/core/usage.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {DatabaseClient} from '../dist/storage/database-client.js';

const quota=(limit=10,key='total')=>({key,amount:1,limit,label:'动作'});
const date='2026-10-27',now=()=>new Date('2026-10-27T04:00:00Z');
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-sqlite-usage-')),path=join(root,'额度 usage.json'),store=new SqliteDailyUsageStore(path,now);try{await run({root,path,store});}finally{await store.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}

test('旧额度原文及备份保留，当天已用量迁移并继续预扣，重启不会重置额度',()=>fixture(async({root,path,store})=>{
  const legacy=new DailyUsageStore(path,now);await legacy.load();await legacy.consume(()=>[quota()]);const before=await readFile(path);await store.load();assert.equal(store.used('total'),1);
  await store.consume(()=>[quota()]);assert.equal(store.used('total'),2);await store.close();const reopened=new SqliteDailyUsageStore(path,now);try{await reopened.load();assert.equal(reopened.used('total'),2);}finally{await reopened.close();}
  assert.deepEqual(await readFile(path),before);const backup=(await readdir(root)).find(name=>name.includes('.pre-sqlite-'));assert.deepEqual(await readFile(join(root,backup)),before);
  await writeFile(path,before.toString()+'\n');const stale=new SqliteDailyUsageStore(path,now);try{await assert.rejects(stale.load(),/迁移后发生变化/);}finally{await stale.close();}
}));

test('两个真实 Worker 的并发预扣不超发，只有成功提交后才调用已预扣回调',()=>fixture(async({path,store})=>{
  await store.load();const second=new SqliteDailyUsageStore(path,now);await second.load();let reserved=0;
  try{
    const result=await Promise.allSettled(Array.from({length:64},(_,i)=>[store,second][i%2].consume(()=>[quota()],()=>reserved++)));assert.equal(result.filter(r=>r.status==='fulfilled').length,10);assert.equal(reserved,10);assert.ok(result.filter(r=>r.status==='rejected').every(r=>r.reason.code==='DATABASE_QUOTA_EXCEEDED'));
    const db=new DatabaseSync(path+'.sqlite',{readOnly:true});try{assert.equal(db.prepare('SELECT used FROM daily_usage WHERE date=? AND key=?').get(date,'total').used,10);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_reservations').get().n,10);}finally{db.close();}
  }finally{await second.close();}
}));

test('总额与专用额度一起回滚；唯一预扣编号重试不重复预扣，内容更换被拒绝',()=>fixture(async({path,store})=>{
  await store.load();await assert.rejects(store.consume(()=>[quota(),quota(0,'likes')]),/额度不足/);assert.equal(store.used('total'),0);await store.close();
  const client=new DatabaseClient(path+'.sqlite');try{
    const request={action:'usage-consume',date,quotas:[quota()],reservationId:'logical-reservation',at:now().getTime()};const first=await client.call(request),again=await client.call(request);assert.equal(first.counters.total,1);assert.equal(again.counters.total,1);assert.equal(again.reused,true);
    await assert.rejects(client.call({...request,quotas:[quota(10,'other')]}),error=>error.code==='DATABASE_RESERVATION_CONFLICT');assert.equal((await client.call({action:'usage-summary',date})).counters.total,1);
  }finally{await client.close();}
}));

test('上海日期切换单独统计，时钟回退不能清空原日期已用量；排队时读取最新限制',()=>fixture(async({path})=>{
  let current=new Date('2026-10-26T15:59:59Z'),limit=1;const usage=new SqliteDailyUsageStore(path,()=>current);
  try{
    await usage.load();await usage.consume(()=>[quota(limit)]);current=new Date('2026-10-26T16:00:01Z');assert.equal(usage.used('total'),0);await usage.consume(()=>[quota(limit)]);assert.equal(usage.used('total'),1);
    current=new Date('2026-10-26T15:59:59Z');await assert.rejects(usage.consume(()=>[quota(limit)]),/额度不足/);assert.equal(usage.used('total'),1);
    limit=0;await assert.rejects(usage.consume(()=>[quota(limit)]),/额度不足/);
  }finally{await usage.close();}
}));

test('额度已经提交后宿主退出仍保留预扣，不自动退回；不允许混用社交与额度数据库',()=>fixture(async({root,path})=>{
  const script=join(root,'crash.mjs');await writeFile(script,`import{SqliteDailyUsageStore}from ${JSON.stringify(pathToFileURL(resolve('dist/storage/sqlite-usage-store.js')).href)};const store=new SqliteDailyUsageStore(${JSON.stringify(path)},()=>new Date('2026-10-27T04:00:00Z'));await store.load();await store.consume(()=>[${JSON.stringify(quota(1))}],()=>process.exit(42));`);
  const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});const [code]=await once(child,'exit');assert.equal(code,42);
  const reopened=new SqliteDailyUsageStore(path,now);try{await reopened.load();assert.equal(reopened.used('total'),1);await assert.rejects(reopened.consume(()=>[quota(1)]),/额度不足/);}finally{await reopened.close();}
  const invalid=new SqliteSocialStore(path);try{await assert.rejects(invalid.load(),/类型无效/);}finally{await invalid.close();}
}));

test('数据库 schema 1 升级时保留全部既有社交条目',()=>fixture(async({root})=>{
  const path=join(root,'social.json'),store=new SqliteSocialStore(path);try{await store.load();await store.account(123);}finally{await store.close();}
  const old=new DatabaseSync(path+'.sqlite');try{old.exec('DROP TABLE daily_usage;DROP TABLE quota_reservations;PRAGMA user_version=1;');}finally{old.close();}
  const upgraded=new SqliteSocialStore(path);try{await upgraded.load();assert.equal(upgraded.view('account').account,123);}finally{await upgraded.close();}
  const wrong=new SqliteDailyUsageStore(path,now);try{await assert.rejects(wrong.load(),/类型或迁移状态无效/);}finally{await wrong.close();}
}));
