import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {IntervalClock} from '../dist/core/interval-clock.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {DailyUsageStore} from '../dist/core/usage.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {Autonomy} from '../dist/agent/autonomy.js';

test('已观测间隔按单调时间推进，墙钟前拨不加速、回拨不重置，实际提交重新起算',()=>{
  let wall=Date.now(),mono=100;const clock=new IntervalClock(()=>wall,()=>mono),stamp=wall;clock.mark('decision',stamp);
  wall+=7*86400000;assert.equal(clock.due('decision',stamp,30000),false);mono+=29999;assert.equal(clock.due('decision',stamp,30000),false);
  wall-=30*86400000;mono++;assert.equal(clock.due('decision',stamp,30000),true);clock.mark('decision',wall);assert.equal(clock.due('decision',wall,30000),false);mono+=30000;assert.equal(clock.due('decision',wall,30000),true);
});

test('重启遇到未来时间戳只等待一个间隔，睡眠恢复不会把多个积压间隔当成多次机会',()=>{
  let wall=2000000,mono=0;const clock=new IntervalClock(()=>wall,()=>mono);assert.equal(clock.due('scan',wall+86400000,60000),false);
  mono+=60000;assert.equal(clock.due('scan',wall+86400000,60000),true);clock.mark('scan',wall);
  wall+=86400000;mono+=86400000;assert.equal(clock.due('scan',2000000,60000),true);clock.mark('scan',wall);
  assert.equal(clock.due('scan',wall,60000),false);mono+=30000;assert.equal(clock.due('scan',wall,60000),false);assert.equal(clock.due('scan',wall,30000),true);
});

test('间隔观测缓存有上限；未初始化记录可运行，非法持久时间或间隔明确拒绝',()=>{
  let mono=0;const clock=new IntervalClock(()=>1000000,()=>mono,3);for(let i=0;i<100;i++){clock.due('key-'+i,999999,5000);mono++;}assert.equal(clock.size,3);assert.equal(clock.due('none',0,5000),true);assert.equal(clock.size,3);
  assert.throws(()=>clock.due('invalid',Infinity,1),/无效/);assert.throws(()=>clock.due('invalid',1,-1),/无效/);assert.throws(()=>new IntervalClock(Date.now,Date.now,0),/容量/);
});

test('真实自主仓储在墙钟前拨时不连发、回拨后重新查询到期机会，原决策时间不改写',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-interval-')),store=new SqliteSocialStore(join(root,'social.json'));let wall=Date.now(),mono=0;const initial=wall,day=86400000,s=structuredClone(DEFAULT_SETTINGS),signal=new AbortController().signal;
  Object.assign(s.social,{proactiveEnabled:true,quietStartHour:0,quietEndHour:0,autoQzoneEnabled:false,autoQzoneCommentEnabled:false,autoCollectStickers:false});
  const thought=(id,chat,at)=>({id,key:id,chat,kind:'chat',summary:'实际计划',reason:'受控时钟验证',at,due:at-1,expires:initial+30*day,priority:50,state:'pending',result:''});
  try{
    await store.load();await store.update(d=>{d.autonomous.lastScanAt=wall;d.autonomous.thoughts=[thought('first','private:20001',wall),thought('second','private:20002',wall)];});
    const usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();const autonomy=new Autonomy(store,()=>s,usage,()=>wall,undefined,new IntervalClock(()=>wall,()=>mono));let wakes=0;
    const tick=()=>autonomy.tick(signal,async(_,turn)=>{wakes++;turn.effects.add('chat');});
    await tick();assert.equal(wakes,1);wall+=day;await tick();await tick();assert.equal(wakes,1);mono+=30000;await tick();assert.equal(wakes,2);
    wall=initial-day;await store.update(d=>{d.autonomous.thoughts.push(thought('after-rollback','private:30001',wall));});await tick();assert.equal(wakes,2);mono+=30000;await tick();assert.equal(wakes,3);
    const decisions=store.view('autonomous').autonomous.decisions;assert.deepEqual(decisions.map(row=>row.at),[initial,initial+day,initial-day]);assert.equal(usage.used('autonomous-decisions'),3);
  }finally{await store.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
