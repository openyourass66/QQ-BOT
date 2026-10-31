import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {cp,lstat,mkdir,open,readFile,readdir,realpath,rename,rm,statfs,symlink,unlink,writeFile} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {loadReleaseTrust,releaseHash,verifyReleasePackage} from './release-integrity.mjs';

/**
 * Linux 服务器端安装/升级入口：签名校验后复制到版本目录，
 * 原子切换 current 链接并重启 systemd；新版本检查或启动失败时自动切回上一版。
 * 程序升级不修改数据目录；备份、恢复与跨设备迁移仍由桌面维护入口执行。
 */

const stateName='whaled-state.json',journalName='upgrade-journal.json',lockName='upgrade.lock';
const fail=(message,code='UPGRADE_INVALID')=>Object.assign(new Error(message),{code});
const optional=path=>lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
const normalized=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const inside=(root,path)=>{const rel=relative(root,path);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,digest=/^[a-f0-9]{64}$/;

function usage(){return [
  '用法：sudo node scripts/whaled-upgrade.mjs --package <目录> --install-root <目录> --data-dir <目录> [选项]',
  '  --package <目录>       已解压且已签名的完整发行目录',
  '  --install-root <目录>  受管程序目录（releases/ 与 current 链接所在位置）',
  '  --data-dir <目录>      机器人数据目录（升级不会修改其内容）',
  '  --trust <文件>         发布公钥清单；首次安装必填，之后默认使用安装目录中的副本',
  '  --service <名称>       systemd 单元名，默认 whaled.service',
  '  --node <路径>          使用指定 Node 可执行文件；默认发行包内 runtime/bin/node',
  '  --rollback             回退到上次升级前的版本（仅程序文件）',
  '  --recover              处理上次中断的升级',
  '  --dry-run              只校验并打印计划，不切换程序或重启服务',
].join('\n');}

function run(command,argv){return new Promise((done,reject)=>{
  const child=spawn(command,argv,{stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
  child.stdout.on('data',chunk=>{if(stdout.length<65536)stdout+=chunk;});
  child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});
  child.once('error',reject);child.once('close',code=>code===0?done(stdout):reject(fail(`${command} 退出代码 ${code}${stderr.trim()?'：'+stderr.trim():''}`,'UPGRADE_COMMAND_FAILED')));
});}

async function service(action,values){
  // 失败的版本会触发 Restart=on-failure 与启动频率限制；回退前先清除 failed 与限制，
  // 否则旧版本本身可用却会被 systemd 以“启动过于频繁”拒绝。
  if(action==='start')try{await run('systemctl',['reset-failed',values.service]);}catch{}
  try{await run('systemctl',[action,values.service]);}
  catch(error){if(action==='stop'&&/not loaded|not found|No such file/i.test(error.message))return;throw fail(`无法${action==='start'?'启动':'停止'} ${values.service}：${error.message}`,'UPGRADE_SERVICE_FAILED');}
}

async function atomicJson(path,value){
  const temporary=path+'.tmp-'+randomUUID();
  try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}

function validateState(state){
  if(!state||state.formatVersion!==1||state.appId!=='whale-workbench'||!uuid.test(state.installationId)||typeof state.dataRoot!=='string'||!isAbsolute(state.dataRoot)||!state.current||!uuid.test(state.current.id)||state.previous!==null&&state.previous&&!uuid.test(state.previous.id))throw fail('安装状态无效，已保留程序与数据。');
  return state;
}

async function readState(installRoot){
  const info=await optional(join(installRoot,stateName));if(!info)return null;
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>131072)throw fail('安装状态类型或大小无效。');
  try{return validateState(JSON.parse(await readFile(join(installRoot,stateName),'utf8')));}catch(error){if(error.code==='UPGRADE_INVALID')throw error;throw fail('安装状态已损坏，请保留现有目录。');}
}

async function acquireLock(installRoot){
  const path=join(installRoot,lockName);
  for(let attempt=0;attempt<2;attempt++){
    try{const handle=await open(path,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();return async()=>{await rm(path,{force:true});};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let pid;try{pid=Number((await readFile(path,'utf8')).trim());}catch{}
      let alive=false;if(Number.isSafeInteger(pid)&&pid>0)try{process.kill(pid,0);alive=true;}catch{}
      if(alive)throw fail('另一个升级进程正在处理此安装目录。');
      await rm(path,{force:true});
    }
  }
  throw fail('无法取得升级锁，请稍后重试。');
}

async function switchCurrent(installRoot,id){
  const link=join(installRoot,'current'),info=await optional(link);
  if(info&&!info.isSymbolicLink())throw fail('程序目录的 current 不是版本链接，请改用受管安装目录。');
  if(id===null){if(info)await rm(link);return;}
  const temporary=join(installRoot,'.current-'+randomUUID());
  try{await symlink(join('releases',id),temporary);await rename(temporary,link);}finally{await rm(temporary,{force:true});}
}

async function health(dataRoot,timeout=45000){
  const socketPath=join(dataRoot,'run','whaled.sock'),deadline=Date.now()+timeout;
  for(;;){
    const result=await new Promise(done=>{
      const socket=connect(socketPath);let settled=false,buffer='';
      const finish=(ok,detail)=>{if(settled)return;settled=true;socket.destroy();done({ok,detail});};
      socket.setTimeout(5000,()=>finish(false,'管理接口无响应'));
      socket.once('error',error=>finish(false,error.message));
      socket.once('connect',()=>socket.write(JSON.stringify({action:'load'})+'\n'));
      socket.on('data',chunk=>{
        buffer+=chunk;let index;
        while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
          let message;try{message=JSON.parse(line);}catch{continue;}
          if(message.type==='config')return finish(true,'管理核心已就绪');
          if(message.type==='error')return finish(false,message.text||'启动检查失败');
        }
        if(buffer.length>4*1024*1024)finish(false,'管理接口响应过大');
      });
      socket.once('close',()=>finish(false,'管理接口已断开'));
    });
    if(result.ok)return result.detail;
    if(Date.now()>=deadline)throw fail(`新版本未能在 ${Math.round(timeout/1000)} 秒内通过启动检查。`,'UPGRADE_HEALTH_FAILED');
    await new Promise(done=>setTimeout(done,400));
  }
}

async function checkRelease(directory,dataRoot,node){
  let output;
  try{output=await run(node,[join(directory,'scripts/install-check.mjs'),'--data-dir',dataRoot]);}
  catch(error){throw fail('新版本安装检查未通过，业务未启动；旧版本保持可用。','UPGRADE_CHECK_FAILED');}
  try{if(JSON.parse(output).ok!==true)throw Error();}catch{throw fail('新版本安装检查未通过，业务未启动；旧版本保持可用。','UPGRADE_CHECK_FAILED');}
}

async function releaseNode(directory,explicit){
  const node=explicit?resolve(explicit):join(directory,'runtime','bin','node');
  const info=await lstat(node).catch(()=>undefined);
  if(!info||!info.isFile())throw fail(`找不到固定 Node 运行环境：${node}。请使用完整发行包或指定 --node。`);
  return node;
}

function compareVersion(left,right){
  const numbers=value=>value.split('-')[0].split('.').map(Number);const a=numbers(left),b=numbers(right);
  for(let i=0;i<3;i++){const order=Math.sign(a[i]-b[i]);if(order)return order;}return 0;
}

async function prepare(values){
  if(process.platform!=='linux')throw fail('本脚本用于 Linux 服务器；Windows 请使用桌面安装升级工具。');
  if(process.getuid?.()!==0)throw fail('安装升级需要 root 权限，请使用 sudo 运行。');
  const installRoot=await realpath(resolve(values['install-root'])).catch(()=>{throw fail('安装目录不存在，请先创建并设置合适权限。');});
  const dataRoot=await realpath(resolve(values['data-dir'])).catch(()=>{throw fail('数据目录不存在，请先运行一次服务或快速配置。');});
  if(inside(installRoot,dataRoot)||inside(dataRoot,installRoot))throw fail('程序安装目录和数据目录必须独立，不能互相包含。');
  if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(values.service))throw fail('systemd 单元名无效。');
  const packageRoot=await realpath(resolve(values.package)).catch(()=>{throw fail('发行目录不存在。');});
  if(inside(packageRoot,installRoot)||inside(installRoot,packageRoot))throw fail('请使用安装目录之外的完整发行包。');
  const trustFile=await (async()=>{
    if(values.trust)return realpath(resolve(values.trust)).catch(()=>{throw fail('发行信任清单不存在。');});
    const stored=join(installRoot,'trust.json');if(await optional(stored))return stored;
    throw fail('首次安装需要 --trust 指向已发布的公钥清单。');
  })();
  const state=await readState(installRoot);
  if(state&&normalized(state.dataRoot)!==normalized(dataRoot))throw fail('此安装已绑定其它数据目录，不能静默切换实例。');
  const checked=await verifyReleasePackage({packageRoot,trustFile});
  const releasedTrust=await loadReleaseTrust(trustFile);
  if(state&&await optional(join(installRoot,'trust.json'))){
    const previous=await loadReleaseTrust(join(installRoot,'trust.json'));
    if(previous.keys.some(key=>!releasedTrust.keys.some(next=>next.id===key.id&&next.modulus===key.modulus&&next.exponent===key.exponent&&key.channels.every(channel=>next.channels.includes(channel)))))throw fail('新发行未保留当前信任公钥，无法保证失败回退；请使用兼容的发行包。');
  }
  if(state&&checked.manifest.channel==='stable'&&compareVersion(checked.manifest.version,state.current.version)<0)throw fail('不能用安装升级执行降级，请使用 --rollback。');
  if(checked.manifest.sourceRevision===state?.current?.sourceRevision&&checked.manifest.version===state?.current?.version&&checked.manifestSha256===state?.current?.manifestSha256)throw fail('所选发行与当前版本相同，无需升级。');
  return {installRoot,dataRoot,packageRoot,trustFile,state,checked};
}

async function install(values){
  const {installRoot,dataRoot,packageRoot,trustFile,state,checked}=await prepare(values);
  if(await optional(join(installRoot,journalName)))throw fail('上次升级未收尾，请先运行 --recover。','UPGRADE_RECOVERY_REQUIRED');
  const releaseRoot=join(installRoot,'releases');await mkdir(releaseRoot,{recursive:true});
  if((await readdir(releaseRoot)).length>=20)throw fail('保留的版本目录已达 20 个，请核对后整理。');
  const files=checked.manifest.files;const needed=files.reduce((sum,file)=>sum+file.size,0),space=await statfs(installRoot);
  if(space.bavail*space.bsize<needed+64*1024*1024)throw fail('程序磁盘空间不足，旧版未切换。','ENOSPC');
  const id=randomUUID(),directory=join(releaseRoot,id);
  console.log(`校验通过：${checked.manifest.version}（${checked.keyId}），准备复制到 ${directory}…`);
  if(values['dry-run']){console.log('演练完成：未复制文件、未切换版本、未重启服务。');return {operation:'upgrade-dry-run',version:checked.manifest.version};}
  const unlock=await acquireLock(installRoot);
  try{
    await cp(packageRoot,directory,{recursive:true,errorOnExist:true,force:false});
    const staged=await verifyReleasePackage({packageRoot:directory,trustFile});
    if(staged.manifestSha256!==checked.manifestSha256)throw fail('复制期间发行来源发生变化，旧版未切换。');
    const node=await releaseNode(directory,values.node);
    await service('stop',values);
    const next={id,version:checked.manifest.version,sourceRevision:checked.manifest.sourceRevision,manifestSha256:checked.manifestSha256,directory:process.platform==='win32'?directory:relative(installRoot,directory).split('\\').join('/')};
    const journal={version:1,id,installationId:state?.installationId??randomUUID(),phase:'prepared',dataRoot,service:values.service,previous:state?.current??null,next,createdAt:new Date().toISOString()};
    try{
      await checkRelease(directory,dataRoot,node);
      await atomicJson(join(installRoot,journalName),journal);
      await switchCurrent(installRoot,id);
      await service('start',values);
      await health(dataRoot);
    }catch(error){
      let recovered=true;let detail='';
      try{
        await service('stop',values);
        if(state?.current){await switchCurrent(installRoot,state.current.id);await service('start',values);await health(dataRoot);}
        else{await switchCurrent(installRoot,null);await service('stop',values);}
      }catch(revertError){recovered=false;detail='：'+revertError.message;}
      if(!recovered)throw fail(`升级失败且未能恢复上一版本${detail}；请保留现场并运行 --recover。`,'UPGRADE_RECOVERY_REQUIRED');
      await rm(join(installRoot,journalName),{force:true});
      throw fail(`升级失败，已切回上一版本并恢复服务：${error.message}`);
    }
    await writeFile(join(installRoot,'trust.json'),await readFile(trustFile),{mode:0o600});
    await atomicJson(join(installRoot,stateName),{formatVersion:1,appId:'whale-workbench',installationId:journal.installationId,dataRoot,current:next,previous:state?.current??null,updatedAt:new Date().toISOString()});
    await rm(join(installRoot,journalName),{force:true});
    console.log(`已切换到 ${next.version}；上一版本${state?.current?` ${state.current.version} 可用于 --rollback`:'保留为空'}。`);
    return {operation:'install',version:next.version,installRoot,dataRoot,previous:state?.current??null};
  }finally{await unlock();}
}

async function rollback(values){
  if(process.platform!=='linux')throw fail('本脚本用于 Linux 服务器。');
  if(process.getuid?.()!==0)throw fail('回退需要 root 权限，请使用 sudo 运行。');
  const installRoot=await realpath(resolve(values['install-root'])).catch(()=>{throw fail('安装目录不存在。');});
  const dataRoot=await realpath(resolve(values['data-dir'])).catch(()=>{throw fail('数据目录不存在。');});
  if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(values.service))throw fail('systemd 单元名无效。');
  if(await optional(join(installRoot,journalName)))throw fail('上次升级未收尾，请先运行 --recover。','UPGRADE_RECOVERY_REQUIRED');
  const state=await readState(installRoot);
  if(!state?.previous)throw fail('没有可回退的上一版本。');
  if(normalized(state.dataRoot)!==normalized(dataRoot))throw fail('数据目录与安装记录不一致，已拒绝回退。');
  const trustFile=join(installRoot,'trust.json');if(!await optional(trustFile))throw fail('缺少发行信任清单副本，无法验证上一版本。');
  const directory=join(installRoot,'releases',state.previous.id);
  const checked=await verifyReleasePackage({packageRoot:directory,trustFile});
  if(checked.manifestSha256!==state.previous.manifestSha256)throw fail('上一版本文件已改变，不能回退。');
  if(values['dry-run']){console.log(`演练完成：将从 ${state.current.version} 回退到 ${state.previous.version}，未切换。`);return {operation:'rollback-dry-run',version:state.previous.version};}
  const unlock=await acquireLock(installRoot);
  try{
    const journal={version:1,id:randomUUID(),installationId:state.installationId,phase:'prepared',dataRoot,service:values.service,previous:state.current,next:state.previous,createdAt:new Date().toISOString()};
    await atomicJson(join(installRoot,journalName),journal);
    await service('stop',values);
    try{
      await switchCurrent(installRoot,state.previous.id);await service('start',values);await health(dataRoot);
    }catch(error){
      let recovered=true,detail='';
      try{await switchCurrent(installRoot,state.current.id);await service('start',values);await health(dataRoot);}catch(revertError){recovered=false;detail='：'+revertError.message;}
      if(!recovered)throw fail(`回退失败且未能恢复当前版本${detail}；请保留现场并运行 --recover。`,'UPGRADE_RECOVERY_REQUIRED');
      await rm(join(installRoot,journalName),{force:true});
      throw fail(`回退失败，已切回 ${state.current.version}：${error.message}`);
    }
    await atomicJson(join(installRoot,stateName),{...state,current:state.previous,previous:null,updatedAt:new Date().toISOString()});
    await rm(join(installRoot,journalName),{force:true});
    console.log(`已回退到 ${state.previous.version}。数据目录未修改。`);
    return {operation:'rollback',version:state.previous.version,installRoot,dataRoot};
  }finally{await unlock();}
}

async function recover(values){
  if(process.platform!=='linux')throw fail('本脚本用于 Linux 服务器。');
  if(process.getuid?.()!==0)throw fail('处理升级中断需要 root 权限，请使用 sudo 运行。');
  const installRoot=await realpath(resolve(values['install-root'])).catch(()=>{throw fail('安装目录不存在。');});
  const dataRoot=await realpath(resolve(values['data-dir'])).catch(()=>{throw fail('数据目录不存在。');});
  if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(values.service))throw fail('systemd 单元名无效。');
  const info=await optional(join(installRoot,journalName));
  if(!info)return {operation:'recover',recovered:false};
  let journal;try{journal=JSON.parse(await readFile(join(installRoot,journalName),'utf8'));}catch{throw fail('升级记录损坏，请保留现场并人工核对。');}
  if(journal.version!==1||!uuid.test(journal.id)||normalized(journal.dataRoot)!==normalized(dataRoot)||journal.service!==values.service||!journal.next||!uuid.test(journal.next.id))throw fail('升级记录与当前安装不匹配，请保留现场。');
  const state=await readState(installRoot),unlock=await acquireLock(installRoot);
  try{
    await service('stop',values);
    const keep=state?.current?.id===journal.next.id&&await optional(join(installRoot,'current','scripts','whaled.mjs'));
    if(keep){await switchCurrent(installRoot,journal.next.id);await service('start',values);await health(dataRoot);}
    else if(state?.current){await switchCurrent(installRoot,state.current.id);await service('start',values);await health(dataRoot);}
    else{await switchCurrent(installRoot,null);await service('stop',values);}
    await rm(join(installRoot,journalName),{force:true});
    console.log(keep?'已确认升级后的版本，完成收尾。':'已撤回未完成的升级，恢复上一版本。');
    return {operation:'recover',recovered:true,committed:keep};
  }finally{await unlock();}
}

async function main(){
  let values;try{({values}=parseArgs({options:{
    package:{type:'string'},'install-root':{type:'string'},'data-dir':{type:'string'},trust:{type:'string'},
    service:{type:'string',default:'whaled.service'},node:{type:'string'},
    rollback:{type:'boolean',default:false},recover:{type:'boolean',default:false},'dry-run':{type:'boolean',default:false}
  }}));}catch{throw fail(usage());}
  if(values.recover)return recover(values);
  if(!values['install-root']||!values['data-dir'])throw fail(usage());
  if(values.rollback)return rollback(values);
  if(!values.package)throw fail(usage());
  return install(values);
}

try{const result=await main();console.log(JSON.stringify({ok:true,...result}));}
catch(error){console.error(error.message);process.exitCode=1;}
