import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {copyRuntimeHost} from './helpers/runtime.mjs';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qq-runtime-'));
  try {
    const app=join(root,'app'),data=join(root,'data');await mkdir(app);await mkdir(data);await copyRuntimeHost(app);
    await writeFile(join(app,'desktop/diagnostics.mjs'),"export async function environment(){return {BOT_ONEBOT_MODE:'managed',ONEBOT_TOKEN:'fixture-private-token'}};export async function diagnose(){return {ok:true,rows:[]}};export async function onebotOnline(){return false};");
    await writeFile(join(app,'scripts/napcat-node.mjs'),"console.log('WebUi Token: fixture-private-webui');console.log('https://txz.qq.com/p?k=fixture-private-qr');console.log('██');process.on('message',()=>{});setInterval(()=>{},1000);");
    await writeFile(join(app,'dist/bridge.js'),"console.log('runtime-ready');process.on('message',m=>{if(m==='shutdown')process.exit()});setInterval(()=>{},1000);");
    const {createRuntimeService}=await import(pathToFileURL(join(app,'scripts/runtime-service.mjs')).href);
    await run({root:app,layout:{dataRoot:data,logDir:join(data,'data/desktop')},createRuntimeService});
  } finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
async function until(check) {const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'Runtime event deadline exceeded');await new Promise(done=>setTimeout(done,20));}}

test('管理核心与桌面无关，单实例互斥、关闭幂等且退出后能重新取得租约',()=>fixture(async({createRuntimeService,...options})=>{
  const events=[],first=await createRuntimeService({...options,onEvent:event=>events.push(event)});
  try {await assert.rejects(createRuntimeService({...options,onEvent:()=>{}}),/资源正在使用/);assert.ok(events.some(event=>event.type==='state'));}
  finally{const a=first.close(),b=first.close();assert.equal(a,b);await a;}
  const second=await createRuntimeService({...options,onEvent:()=>{}});await second.close();
}));

test('管理核心拒绝未知命令后仍可工作，停止只结束自有进程，日志不保存登录凭据',()=>fixture(async({createRuntimeService,...options})=>{
  const events=[],service=await createRuntimeService({...options,onEvent:event=>events.push(event)});
  try {
    await assert.rejects(service.receive({action:'shell',data:'untrusted'}),/未知/);
    await service.receive({action:'diagnose'});assert.ok(events.some(event=>event.type==='diagnostics'));
    await service.receive({action:'start'});await until(()=>events.some(event=>event.text?.includes('runtime-ready')));
    await service.receive({action:'stop'});
    assert.ok(events.some(event=>event.type==='control'&&event.action==='stop'&&event.ok));
    assert.doesNotMatch(await readFile(join(options.layout.logDir,'console.log'),'utf8'),/fixture-private-webui|fixture-private-qr|██/);
  } finally{await service.close();}
}));

test('管理宿主被强制结束后，租约随 IPC 断开释放，不依赖删除旧锁',()=>fixture(async({createRuntimeService,...options})=>{
  const child=spawn(process.execPath,[join(options.root,'desktop/host.mjs'),'--data-dir',options.layout.dataRoot],{cwd:options.root,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const events=[];let errors='';child.stderr.on('data',bytes=>errors+=bytes);createInterface({input:child.stdout}).on('line',line=>events.push(JSON.parse(line)));
  try {
    await until(()=>events.some(event=>event.type==='state')||child.exitCode!==null);assert.equal(child.exitCode,null,errors);
    await assert.rejects(createRuntimeService({...options,onEvent:()=>{}}),/资源正在使用/);
    const exited=once(child,'exit');child.kill();await exited;
    let replacement;const end=Date.now()+5000;
    while(!replacement){try{replacement=await createRuntimeService({...options,onEvent:()=>{}});}catch(error){if(!/资源正在使用/.test(error.message)||Date.now()>end)throw error;await new Promise(done=>setTimeout(done,20));}}
    await replacement.close();
  } finally {if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
}));

test('桥接异常退出后单独恢复，QQ 进程保留；等待登录与就绪状态按实际连接报告',{timeout:20000},()=>fixture(async({createRuntimeService,...options})=>{
  const marker=join(options.layout.dataRoot,'attempts');
  await writeFile(join(options.root,'scripts/napcat-node.mjs'),"console.log('napcat-once');process.on('message',()=>{});setInterval(()=>{},1000);");
  await writeFile(join(options.root,'dist/bridge.js'),`import{readFileSync,writeFileSync}from'node:fs';let n=0;try{n=Number(readFileSync(${JSON.stringify(marker)},'utf8'))}catch{}writeFileSync(${JSON.stringify(marker)},String(n+1));process.on('message',m=>{if(m==='shutdown')process.exit()});process.send({type:'status',acpConnected:true,qqOnline:false,wsConnected:true});if(!n)setTimeout(()=>{process.send({type:'fatal',failure:{code:'MODEL_EXITED',recoverable:true,message:'模型退出'}});process.exit(1)},100);else setTimeout(()=>process.send({type:'status',acpConnected:true,qqOnline:true,wsConnected:true}),100);setInterval(()=>{},1000);`);
  const events=[],service=await createRuntimeService({...options,onEvent:event=>events.push(event)});
  try{
    await service.receive({action:'start'});await until(()=>events.some(e=>e.phase==='waiting_login'));await until(()=>events.some(e=>e.phase==='recovering'));await until(()=>events.some(e=>e.phase==='ready'));
    assert.equal(await readFile(marker,'utf8'),'2');assert.equal(events.filter(e=>e.text?.includes('[napcat] napcat-once')).length,1);
    await service.receive({action:'restartBridge'});await until(()=>events.filter(e=>e.phase==='ready').length>=2);assert.equal(await readFile(marker,'utf8'),'3');
    await service.receive({action:'stop'});assert.equal(events.filter(e=>e.type==='state').at(-1).phase,'stopped');
  }finally{await service.close();}
}));

test('损坏数据转为待处理且不自动重启；手动处理后可以重新启动',{timeout:15000},()=>fixture(async({createRuntimeService,...options})=>{
  const entry=join(options.root,'dist/bridge.js');await writeFile(entry,"process.send({type:'fatal',failure:{code:'DATA_INVALID',recoverable:false,message:'数据需要恢复'}});setTimeout(()=>process.exit(1),50);");
  const events=[],service=await createRuntimeService({...options,onEvent:event=>events.push(event)});
  try{
    await service.receive({action:'start'});await until(()=>events.some(e=>e.phase==='needs_attention'));await new Promise(done=>setTimeout(done,1300));assert.equal(events.filter(e=>e.type==='state').at(-1).supervision.bridge.failure.code,'DATA_INVALID');assert.ok(!events.some(e=>e.phase==='recovering'));
    await writeFile(entry,"process.on('message',m=>{if(m==='shutdown')process.exit()});process.send({type:'status',acpConnected:true,qqOnline:true,wsConnected:true});setInterval(()=>{},1000);");
    await service.receive({action:'start'});await until(()=>events.some(e=>e.phase==='ready'));
  }finally{await service.close();}
}));

test('停止命令立即取消退避中的恢复，不产生新的业务进程',{timeout:15000},()=>fixture(async({createRuntimeService,...options})=>{
  const marker=join(options.layout.dataRoot,'started');await writeFile(join(options.root,'dist/bridge.js'),`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},'x');setTimeout(()=>process.exit(1),50);`);
  const events=[],service=await createRuntimeService({...options,onEvent:event=>events.push(event)});
  try{
    await service.receive({action:'start'});await until(()=>events.some(e=>e.phase==='recovering'));await service.receive({action:'stop'});await new Promise(done=>setTimeout(done,1400));assert.equal(await readFile(marker,'utf8'),'x');assert.equal(events.filter(e=>e.type==='state').at(-1).phase,'stopped');
  }finally{await service.close();}
}));
