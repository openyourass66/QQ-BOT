import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProcessSupervisor} from '../scripts/supervisor.mjs';
import {classifyRuntimeFailure} from '../dist/core/runtime-failure.js';
import {consumeLines} from '../scripts/bounded-lines.mjs';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';

test('意外退出按 1/2/4/8/16 秒退避，十分钟最多恢复五次，停止取消未来恢复',async()=>{
  let now=100,recoveries=0;const timers=new Map(),delays=[];
  const supervisor=new ProcessSupervisor({recover:()=>{recoveries++;},now:()=>now,random:()=>.5,schedule:(fn,delay)=>{delays.push(delay);const id=Symbol();timers.set(id,fn);return id;},cancel:id=>timers.delete(id)});
  supervisor.starting('bridge');
  for(let index=0;index<5;index++){
    supervisor.exited('bridge');assert.equal(supervisor.snapshot().bridge.phase,'recovering');const [id,fn]=timers.entries().next().value;timers.delete(id);now+=delays.at(-1);fn();await Promise.resolve();await Promise.resolve();
  }
  assert.deepEqual(delays,[1000,2000,4000,8000,16000]);assert.equal(recoveries,5);
  supervisor.exited('bridge');assert.equal(supervisor.snapshot().bridge.phase,'needs_attention');assert.equal(timers.size,0);
  supervisor.starting('bridge',{manual:true});supervisor.exited('bridge');supervisor.stopped('bridge');assert.equal(timers.size,0);assert.equal(supervisor.snapshot().bridge.phase,'stopped');
});

test('配置、凭据、损坏数据和实例冲突直接待处理；稳定后重新计算失败次数',()=>{
  for(const error of [new SyntaxError('fixture'),{code:'BOT_RESOURCE_LOCKED'},{code:'ENOSPC'},{code:'ENOENT'},{message:'HTTP 401'},{message:'受限工具策略未加载'}])assert.equal(classifyRuntimeFailure(error).recoverable,false);
  assert.equal(classifyRuntimeFailure({code:'MODEL_EXITED'}).recoverable,true);
  let now=10;const supervisor=new ProcessSupervisor({recover:()=>{},now:()=>now,random:()=>.5,schedule:()=>1,cancel:()=>{}});
  supervisor.starting('bridge');supervisor.exited('bridge');supervisor.starting('bridge');supervisor.status('bridge',{ready:true});now+=60001;supervisor.exited('bridge');assert.equal(supervisor.snapshot().bridge.restarts,1);
  supervisor.close();
});

test('子进程无换行输出始终有界，超长行只记录一次且下一行仍可读取',async()=>{
  const stream=new PassThrough(),lines=[];consumeLines(stream,line=>lines.push(line),16);const ended=once(stream,'end');
  for(let index=0;index<100;index++)stream.write(Buffer.alloc(1000,65));stream.end('\n恢复正常\n');await ended;
  assert.equal(lines.length,2);assert.match(lines[0],/已省略/);assert.equal(lines[1],'恢复正常');
});
