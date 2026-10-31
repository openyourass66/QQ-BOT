import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {copyRuntimeHost} from './helpers/runtime.mjs';

const skip = process.platform === 'win32' ? '守护进程只在 Linux 上验证' : false;

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qq-whaled-'));
  try {
    const app=join(root,'app'),data=join(root,'data');await mkdir(app);await mkdir(data);await copyRuntimeHost(app);
    await writeFile(join(app,'desktop/diagnostics.mjs'),"export async function environment(){return {BOT_ONEBOT_MODE:'managed',ONEBOT_TOKEN:'fixture-private-token'}};export async function diagnose(){return {ok:true,rows:[]}};export async function onebotOnline(){return false};");
    await writeFile(join(app,'scripts/napcat-node.mjs'),"console.log('napcat-once');process.on('message',()=>{});setInterval(()=>{},1000);");
    await writeFile(join(app,'dist/bridge.js'),"console.log('runtime-ready');process.on('message',m=>{if(m==='shutdown')process.exit()});setInterval(()=>{},1000);");
    await run({app,data});
  } finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

function startDaemon(app,data) {
  const child=spawn(process.execPath,[join(app,'scripts/whaled.mjs'),'--data-dir',data],{cwd:app,stdio:['ignore','ignore','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
  return {child,exited:once(child,'exit'),stderr:()=>stderr};
}

function startClient(app,data) {
  const child=spawn(process.execPath,[join(app,'scripts/remote-host.mjs'),'--data-dir',data],{cwd:app,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const events=[];createInterface({input:child.stdout}).on('line',line=>{try{events.push(JSON.parse(line));}catch{}});
  let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
  return {child,events,exited:once(child,'exit'),stderr:()=>stderr,send(request){child.stdin.write(JSON.stringify(request)+'\n');}};
}

async function until(check,timeout=8000) {
  const end=Date.now()+timeout;
  while(!check()){assert.ok(Date.now()<end,'等待守护进程事件超时');await new Promise(done=>setTimeout(done,20));}
}

async function settle(child,promise) {
  if(child.exitCode===null&&child.signalCode===null){child.kill();await promise.catch(()=>{});}
}

test('守护进程支持多客户端，关闭控制台连接不停止机器人，quit 结束服务',{skip,timeout:30000},()=>fixture(async({app,data})=>{
  const daemon=startDaemon(app,data),a=startClient(app,data);
  try{
    await until(()=>daemon.stderr().includes('管理接口已就绪'));
    await until(()=>a.events.some(event=>event.type==='state'));
    a.send({action:'diagnose'});
    await until(()=>a.events.some(event=>event.type==='diagnostics'&&event.ok===true));

    const b=startClient(app,data);
    try{
      await until(()=>b.events.some(event=>event.type==='state'));
      b.send({action:'start'});
      await until(()=>b.events.some(event=>event.type==='log'&&event.text==='[bridge] runtime-ready'));
      await until(()=>b.events.some(event=>event.type==='state'&&event.bridge===true));
    }finally{await settle(b.child,b.exited);}

    a.child.stdin.end();
    const [aCode]=await a.exited;
    assert.equal(aCode,0);
    await new Promise(done=>setTimeout(done,300));
    assert.equal(daemon.child.exitCode,null,'所有控制台连接断开后守护进程与机器人应继续运行');

    const c=startClient(app,data);
    try{
      await until(()=>c.events.some(event=>event.type==='state'&&event.bridge===true));
      c.send({action:'quit'});
      const [code]=await daemon.exited;
      assert.equal(code,0);
      await assert.rejects(access(join(data,'run/whaled.sock')),{code:'ENOENT'});
    }finally{await settle(c.child,c.exited);}
  }finally{
    await settle(daemon.child,daemon.exited);
    await settle(a.child,a.exited);
  }
}));

test('残留管理接口会被替换，守护进程重启后恢复运行中的机器人，重复启动直接退出',{skip,timeout:30000},()=>fixture(async({app,data})=>{
  await mkdir(join(data,'run'),{recursive:true,mode:0o700});
  await writeFile(join(data,'run/whaled.sock'),'stale');
  await writeFile(join(data,'run/autostart'),'2026-10-31T00:00:00.000Z\n');
  const daemon=startDaemon(app,data),client=startClient(app,data);
  try{
    await until(()=>daemon.stderr().includes('管理接口已就绪'));
    await until(()=>client.events.some(event=>event.type==='log'&&event.text==='[bridge] runtime-ready'),10000);
    await until(()=>client.events.some(event=>event.type==='state'&&event.bridge===true),10000);

    const duplicate=startDaemon(app,data);
    const [duplicateCode]=await duplicate.exited;
    assert.equal(duplicateCode,0);
    assert.match(duplicate.stderr(),/已有守护进程在运行/);
    assert.equal(daemon.child.exitCode,null);

    client.send({action:'quit'});
    const [code]=await daemon.exited;
    assert.equal(code,0);
    await assert.rejects(access(join(data,'run/autostart')),{code:'ENOENT'});
    await assert.rejects(access(join(data,'run/whaled.sock')),{code:'ENOENT'});
  }finally{
    await settle(daemon.child,daemon.exited);
    await settle(client.child,client.exited);
  }
}));
