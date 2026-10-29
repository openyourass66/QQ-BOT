import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionCache} from '../dist/app/session-cache.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(options={}){const active=new Set(),disposed=[],closed=[],evicted=[],busy=new Set();let sequence=0,peak=0;
  const create=async()=>{const session={sessionId:'session-'+(++sequence),dispose(){disposed.push(this.sessionId);}};active.add(session.sessionId);peak=Math.max(peak,active.size);return session;};
  const cache=new SessionCache({limit:()=>1,idleMs:()=>100,isBusy:key=>busy.has(key),closeRemote:async session=>{closed.push(session.sessionId);active.delete(session.sessionId);},onEvict:(key,_session,reason)=>evicted.push({key,reason}),...options});
  return {cache,create,active,disposed,closed,evicted,busy,peak:()=>peak};
}

test('远端确认前不释放名额，关闭期间同会话请求等待并恢复为有效实例',async()=>{
  let gate=deferred(),started=deferred();const f=fixture({closeRemote:async session=>{started.resolve();await gate.promise;f.active.delete(session.sessionId);}});
  try{const first=await f.cache.acquire('a',f.create),next=f.cache.acquire('b',f.create);await started.promise;assert.equal(f.cache.size,1);assert.equal(f.cache.peek('a'),undefined);assert.equal(f.active.size,1);gate.resolve();const second=await next;
    gate=deferred();started=deferred();const removed=f.cache.remove('b');await started.promise;let returned=false;const same=f.cache.acquire('b',f.create).then(session=>{returned=true;return session;});await Promise.resolve();assert.equal(returned,false);gate.resolve();await removed;
    const restored=await same;assert.notEqual(restored.sessionId,second.sessionId);assert.equal(f.peak(),1);assert.equal(f.cache.size,1);assert.ok(f.disposed.includes(first.sessionId));
  }finally{gate.resolve();f.cache.dispose();}
});

test('同会话创建合并，全忙时拒绝新建；并发创建的预留也计入总上限',async()=>{
  const gate=deferred(),f=fixture({limit:()=>4});try{
    const create=async()=>{await gate.promise;return f.create();};const first=f.cache.acquire('same',create),duplicate=f.cache.acquire('same',create);assert.equal(first,duplicate);
    const tasks=[first,...Array.from({length:20},(_,i)=>f.cache.acquire('key-'+i,create))];const settled=tasks.map(task=>task.then(value=>({value}),error=>({error})));gate.resolve();const results=await Promise.all(settled);assert.equal(results.filter(result=>result.value).length,4);assert.equal(results.filter(result=>result.error?.code==='SESSION_CACHE_FULL').length,17);assert.equal(f.peak(),4);assert.equal(f.cache.size,4);
    f.busy.add('same');for(let i=0;i<3;i++)f.busy.add('key-'+i);await assert.rejects(f.cache.acquire('blocked',f.create),{code:'SESSION_CACHE_FULL'});assert.equal(f.closed.length,0);
  }finally{gate.resolve();f.cache.dispose();}
});

test('空闲淘汰跳过活动轮次，触碰时间刷新；降低容量后逐次回收',async()=>{
  let now=0,limit=3;const f=fixture({limit:()=>limit,now:()=>now});try{
    await f.cache.acquire('a',f.create);now=1;await f.cache.acquire('b',f.create);now=2;await f.cache.acquire('c',f.create);f.busy.add('a');now=101;f.cache.touch('c');await f.cache.sweep();assert.equal(f.cache.peek('b'),undefined);assert.ok(f.cache.peek('a'));assert.ok(f.cache.peek('c'));
    now=150;await f.cache.sweep();assert.equal(f.cache.size,2);limit=1;await f.cache.sweep();assert.equal(f.cache.size,1);assert.ok(f.cache.peek('a'));f.busy.clear();now=200;await f.cache.sweep();assert.equal(f.cache.size,0);assert.equal(f.evicted.filter(event=>event.reason==='idle').length,2);
  }finally{f.cache.dispose();}
});

test('创建失败保留原会话，替换成功先确认旧资源释放；关闭失败停止继续创建',async()=>{
  let fail=false,fatal=0;const f=fixture({limit:()=>2,onFailure:()=>fatal++,closeRemote:async session=>{if(fail)throw new Error('unknown remote outcome');f.active.delete(session.sessionId);f.closed.push(session.sessionId);}});
  try{const original=await f.cache.acquire('a',f.create);await assert.rejects(f.cache.acquire('a',async()=>{throw new Error('create failed');},true),/create failed/);assert.equal(f.cache.peek('a'),original);assert.equal(f.disposed.length,0);
    const replaced=await f.cache.acquire('a',f.create,true);assert.notEqual(replaced,original);assert.deepEqual(f.closed,[original.sessionId]);assert.deepEqual(f.disposed,[original.sessionId]);
    fail=true;await assert.rejects(f.cache.remove('a'),{code:'MODEL_SESSION_RELEASE_FAILED'});assert.equal(fatal,1);assert.equal(f.cache.size,1);await assert.rejects(f.cache.acquire('new',f.create),{code:'MODEL_SESSION_RELEASE_FAILED'});assert.equal(f.active.size,1);
  }finally{f.cache.dispose();}
});

test('活动会话不能由维护入口重置；停止后晚到的创建结果不重新进入缓存',async()=>{
  const gate=deferred(),f=fixture();const original=await f.cache.acquire('a',f.create);f.busy.add('a');await assert.rejects(f.cache.remove('a'),/正在处理/);assert.equal(f.cache.peek('a'),original);f.busy.clear();await f.cache.remove('a');
  const pending=f.cache.acquire('late',async()=>{await gate.promise;return f.create();});await new Promise(done=>setImmediate(done));f.cache.dispose();gate.resolve();await assert.rejects(pending,/已停止/);assert.equal(f.cache.size,0);assert.equal(f.disposed.length,2);await assert.rejects(f.cache.acquire('after',f.create),/已停止/);
});

test('容量已满时换代也不会超出远端活跃上限，先确认释放后才创建',async()=>{
  const f=fixture();try{const first=await f.cache.acquire('a',f.create);const next=await f.cache.acquire('a',f.create,true);assert.notEqual(first,next);assert.equal(f.peak(),1);assert.deepEqual(f.closed,[first.sessionId]);assert.equal(f.cache.size,1);}finally{f.cache.dispose();}
});
