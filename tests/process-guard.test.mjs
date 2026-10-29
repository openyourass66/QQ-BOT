import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ProcessGuard} from '../scripts/process-guard.mjs';

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async check=>{const end=Date.now()+8000;while(!check()){assert.ok(Date.now()<end,'受管进程未按期退出');await new Promise(done=>setTimeout(done,25));}};
async function fixture(run) {
  const directory=await mkdtemp(join(tmpdir(),'qq-process-guard-')),entry=join(directory,'child.mjs');
  await writeFile(entry,"import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.send({type:'descendant',pid:child.pid});process.on('message',m=>{if(m==='finish')process.exit(0)});setInterval(()=>{},1000);");
  const guard=new ProcessGuard({root:resolve('.'),dataRoot:directory});
  try{await run({directory,entry,guard});}finally{await guard.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('业务入口先等待进程树保护，单独停止一棵树不会结束无关进程',{timeout:25000},()=>fixture(async({entry,guard})=>{
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});let descendant;
  try{
    const child=await guard.fork(entry,{cwd:tmpdir()});[descendant]=await once(child,'message');assert.equal(descendant.type,'descendant');
    assert.ok(alive(child.pid)&&alive(descendant.pid));await guard.terminate(child);await until(()=>!alive(child.pid)&&!alive(descendant.pid));assert.ok(alive(unrelated.pid));
  }finally{unrelated.kill();await once(unrelated,'exit');if(descendant?.pid&&alive(descendant.pid))process.kill(descendant.pid);}
}));

test('根进程正常退出仍回收其残留后代，管理服务可以继续运行',{timeout:25000},()=>fixture(async({entry,guard})=>{
  const child=await guard.fork(entry);const [descendant]=await once(child,'message');child.send('finish');await once(child,'exit');await until(()=>!alive(descendant.pid));
  const next=await guard.fork(entry);const [other]=await once(next,'message');await guard.terminate(next);await until(()=>!alive(other.pid));
}));

test('管理宿主被强制结束后受管子孙进程自动退出',{timeout:25000},()=>fixture(async({directory,entry})=>{
  const hostEntry=join(directory,'host.mjs'),url=pathToFileURL(resolve('scripts/process-guard.mjs')).href;
  await writeFile(hostEntry,`import {ProcessGuard} from ${JSON.stringify(url)};const guard=new ProcessGuard({root:${JSON.stringify(resolve('.'))},dataRoot:${JSON.stringify(directory)}});const child=await guard.fork(${JSON.stringify(entry)});child.on('message',m=>process.send({root:child.pid,descendant:m.pid}));setInterval(()=>{},1000);`);
  const host=spawn(process.execPath,[hostEntry],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let pids,errors='';host.stderr.on('data',chunk=>errors+=chunk);
  try{
    [pids]=await Promise.race([once(host,'message'),once(host,'exit').then(()=>{throw new Error('测试宿主启动失败：'+errors);})]);
    host.kill();await once(host,'exit');await until(()=>!alive(pids.root)&&!alive(pids.descendant));
  }finally{if(host.exitCode===null&&host.signalCode===null){host.kill();await once(host,'exit');}for(const pid of Object.values(pids||{}))if(alive(pid))process.kill(pid);}
}));

test('发行版无需源码或编译器；保护组件退出时业务进程树随之回收',{timeout:25000,skip:process.platform!=='win32'},()=>fixture(async({directory,entry,guard})=>{
  await guard.ready();const app=join(directory,'release');await mkdir(join(app,'desktop'),{recursive:true});await mkdir(join(app,'scripts'));
  await cp(guard.helper.spawnfile,join(app,'desktop/runtime-guard.exe'));await cp(resolve('scripts/managed-entry.mjs'),join(app,'scripts/managed-entry.mjs'));
  const bundled=new ProcessGuard({root:app,dataRoot:directory});let lost;
  try{
    bundled.onLost=error=>lost=error;const child=await bundled.fork(entry);const [descendant]=await once(child,'message');bundled.helper.kill();
    await until(()=>lost&&!alive(child.pid)&&!alive(descendant.pid));assert.match(lost.message,/保护组件/);await assert.rejects(bundled.fork(entry),/保护组件/);
  }finally{await bundled.close();}
}));
