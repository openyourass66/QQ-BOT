import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {appendFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// 复现固定组件的 fork 边界，不加载真实 QQ 原生库或连接网络。
assert.equal(process.env.NAPCAT_DISABLE_MULTI_PROCESS,'0');
assert.equal(process.env.NAPCAT_DISABLE_MULTIPROCESSING,'0');
assert.equal(process.env.NAPCAT_FORCE_NODE_PROCESS,'1');
assert.equal(process.env.NAPCAT_DISABLE_PIPE,'1');
assert.equal(process.cwd(),process.env.NAPCAT_WORKDIR);
if(process.env.NAPCAT_WORKER_PROCESS==='1'){
  const native={};process.dlopen(native,process.env.NAPCAT_WRAPPER_PATH);
  const profile=native.exports.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();
  assert.equal(profile,process.env.FIXTURE_EXPECTED_PROFILE);
  process.on('message',message=>{
    if(message==='offline')process.send({type:'restart'});
    if(message==='crash')process.exit(13);
    if(message==='shutdown')process.exit(0);
  });
  process.send({type:'worker-ready',pid:process.pid,profile,originalCalls:globalThis.fixtureOriginalCalls,nodeVersion:process.versions.node,
    config:readFileSync(join(process.env.NAPCAT_WORKDIR,'config/onebot11_10000.json'),'utf8'),
    session:readFileSync(join(profile,'fixture-session.json'),'utf8'),
    wrapper:resolve(process.env.NAPCAT_WRAPPER_PATH)});
}else{
  assert.equal(process.env.NAPCAT_WORKER_PROCESS,'0');
  let worker,stopping=false,restarting=false;
  const launch=()=>{
    // 与固定 NapCat 一样，直接 fork 自己，继承 execArgv，不经过项目启动器。
    const current=fork(fileURLToPath(import.meta.url),[],{
      env:{...process.env,NAPCAT_WORKER_PROCESS:'1'},silent:true,windowsHide:true,
    });
    worker=current;current.stdout.pipe(process.stdout);current.stderr.pipe(process.stderr);
    current.on('error',error=>{console.error(error);process.exit(1);});
    current.on('message',message=>{
      if(message.type==='worker-ready')appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({...message,supervisor:process.pid})+'\n');
      if(message.type==='restart'&&!restarting&&!stopping)void restart().catch(error=>{console.error(error);process.exit(1);});
    });
    current.on('exit',()=>{if(!stopping&&!restarting)launch();});
  };
  async function restart(){
    restarting=true;const exited=once(worker,'exit');worker.send('shutdown');await exited;launch();restarting=false;
  }
  async function stop(){
    if(stopping)return;stopping=true;
    if(worker?.exitCode===null&&worker?.signalCode===null){const exited=once(worker,'exit');worker.send('shutdown');await exited;}
    process.exit(0);
  }
  process.on('message',message=>{if(message==='shutdown')void stop();else worker.send(message);});
  process.on('disconnect',()=>void stop());
  launch();
}
