import {fork} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function acquireRuntimeLease(root,dataRoot) {
  return new Promise((done,reject)=>{
    const worker=fork(join(root,'scripts/runtime-lease.mjs'),['--hold',dataRoot],{cwd:dataRoot,silent:true,execArgv:[],windowsHide:true});
    let ready=false;
    let releasing=false,lost;
    const ended=new Promise(resolve=>{lost=resolve;});
    const timer=setTimeout(()=>{worker.kill();reject(new Error('运行管理实例锁超时'));},5000);
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',()=>{clearTimeout(timer);if(!ready)reject(new Error('运行管理实例锁进程已退出'));lost(releasing?undefined:new Error('运行管理实例锁已失效，正在停止受管进程'));});
    worker.once('message',message=>{
      clearTimeout(timer);
      if(!message.ok){reject(new Error(message.error));return;}
      ready=true;
      done({lost:ended,get held(){return !releasing&&worker.connected&&worker.exitCode===null&&worker.signalCode===null;},release:()=>new Promise(resolve=>{releasing=true;if(worker.exitCode!==null||worker.signalCode!==null)return resolve();worker.once('exit',resolve);worker.send('release',()=>{});})});
    });
  });
}

if(process.argv[2]==='--hold'&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let lease;
  const release=()=>{lease?.release();process.exit();};
  process.once('disconnect',release);process.on('message',message=>{if(message==='release')release();});
  try {
    const {acquireDataResources}=await import('../dist/core/resource-lock.js');
    lease=await acquireDataResources([{path:join(resolve(process.argv[3]),'data/runtime-control'),label:'运行管理服务'}]);
    process.send({ok:true});
  }catch(error){process.send({ok:false,error:error.message},()=>process.disconnect());}
}
