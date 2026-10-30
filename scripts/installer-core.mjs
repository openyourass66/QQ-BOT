import {readFile,writeFile,open,lstat,mkdir,rename,rm,readdir,cp,statfs,rmdir} from 'node:fs/promises';
import {join,resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {canonicalRuntimePath,assertNoPendingRestore} from './app-paths.mjs';
import {withOfflineData,verifyBackup} from './maintenance.mjs';
import {verifyReleasePackage,releaseHash,loadReleaseTrust} from './release-integrity.mjs';

const stateName='install-state.json',journalName='.install-journal.json',markerName='.upgrade-journal.json';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,digest=/^[a-f0-9]{64}$/;
const fail=(message,code='INSTALL_INVALID')=>Object.assign(new Error(message),{code});
const optional=path=>lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
const inside=(root,path)=>{const rel=relative(root,path);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
const normalized=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
async function safeDirectory(path){path=resolve(path);for(let item=path;;item=dirname(item)){if((await optional(item))?.isSymbolicLink())throw fail('安装目录不能使用链接路径。');if(dirname(item)===item)break;}return canonicalRuntimePath(path);}
async function readJson(path){const state=await optional(path);if(!state)return null;if(!state.isFile()||state.isSymbolicLink()||state.nlink!==1||state.size>131072)throw fail('安装记录类型或大小无效。');try{return JSON.parse(await readFile(path,'utf8'));}catch{throw fail('安装记录已损坏，请保留现有目录。');}}
async function saveJson(path,value){
  const existing=await optional(path);if(existing&&(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1))throw fail('安装记录位置被替换，已停止操作。');
  const temporary=path+'.tmp-'+randomUUID();try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
function validRelease(value){return value&&uuid.test(value.id)&&digest.test(value.manifestSha256)&&/^[a-f0-9]{40,64}$/.test(value.sourceRevision)&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?$/.test(value.version);}
function validateState(state){
  if(!state||state.formatVersion!==1||state.appId!=='whale-workbench'||!uuid.test(state.installationId)||typeof state.dataRoot!=='string'||state.dataRoot.length>4096||!isAbsolute(state.dataRoot)||!validRelease(state.current)||state.previous!==null&&!validRelease(state.previous))throw fail('安装状态无效，已保留程序与数据。');
  if(state.lastUpgrade!==null&&(!state.previous||!sameFingerprint(state.lastUpgrade.dataFingerprint,state.lastUpgrade.dataFingerprint)||state.lastUpgrade.backup!==null&&(!/^install-[a-f0-9-]{36}\.wwbackup$/.test(state.lastUpgrade.backup)||!digest.test(state.lastUpgrade.backupSha256))))throw fail('安装恢复点记录无效。');
  return state;
}
export async function installedState(installRoot){installRoot=await safeDirectory(installRoot);const state=await readJson(join(installRoot,stateName));return state?validateState(state):null;}
const releasePath=(installRoot,release)=>join(installRoot,'releases',release.id);
async function checkRelease(directory,dataRoot,signal){
  signal?.throwIfAborted();const env={};for(const key of ['SystemRoot','WINDIR','SystemDrive','TEMP','TMP','PATH','Path'])if(process.env[key])env[key]=process.env[key];
  const executable=join(directory,'runtime',process.platform==='win32'?'node.exe':'node');
  const child=spawn(executable,[join(directory,'scripts/install-check.mjs'),'--data-dir',dataRoot],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','ignore']});let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536)child.kill();});
  const abort=()=>child.kill(),timer=setTimeout(abort,60000);signal?.addEventListener('abort',abort,{once:true});
  try{if(signal?.aborted)abort();await new Promise((done,reject)=>{child.once('error',()=>reject(fail('新版本检查无法启动。')));child.once('exit',code=>{try{signal?.throwIfAborted();if(code!==0||JSON.parse(output).ok!==true)throw Error();done();}catch{reject(fail('新版本检查失败，业务未启动。'));}});});}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function withInstallation({root,installRoot,dataRoot,signal},run){
  root=await canonicalRuntimePath(resolve(root));installRoot=await safeDirectory(installRoot);dataRoot=await canonicalRuntimePath(resolve(dataRoot));
  if(inside(normalized(installRoot),normalized(dataRoot))||inside(normalized(dataRoot),normalized(installRoot)))throw fail('程序安装目录和数据目录必须独立，不能互相包含。');
  await mkdir(installRoot,{recursive:true});await mkdir(dataRoot,{recursive:true});
  const lease=await acquireDataResources([{path:join(installRoot,'installation'),label:'安装升级'},{path:join(dataRoot,'data/runtime-control'),label:'工作台管理服务'}],signal);
  try{return await run({root,installRoot,dataRoot,signal,trustFile:join(root,'components/release-trust.json')});}finally{lease.release();}
}
async function withData(transaction,run){
  const env=await optional(join(transaction.dataRoot,'.env'));
  if(env)return withOfflineData(transaction.dataRoot,{signal:transaction.signal,recovery:true},run);
  const existingData=async()=>{for(const path of ['.env','bot.config.json','bot-workspace','.credentials','data/media','data/sessions.json','data/sessions.json.sqlite','data/social.json','data/social.json.sqlite','data/daily-usage.json','data/daily-usage.json.sqlite','data/group-context.json','data/group-context.json.sqlite'])if(await optional(join(transaction.dataRoot,path)))return true;return false;};
  if(await existingData())throw fail('数据目录存在资料但缺少连接配置，请先修复配置后再安装或升级。');
  const lease=await acquireDataResources(mutableDataResources(dataPaths({},transaction.dataRoot),true),transaction.signal);
  try{return await run({fingerprint:async()=>await existingData()?'changed':'empty',backup:undefined});}finally{lease.release();}
}
function sameFingerprint(left,right){return left===right&&(left==='empty'||digest.test(left));}
async function finish(transaction,journal){
  const {installRoot,dataRoot}=transaction;
  const marker=await readJson(join(dataRoot,markerName));if(marker&&(marker.id!==journal.id||normalized(marker.installRoot)!==normalized(installRoot)||marker.version!==1))throw fail('升级标记不属于所选安装，已保留现场。');
  await rm(join(dataRoot,markerName),{force:true});await rm(join(installRoot,journalName));
}
function validateJournal(transaction,journal,current){
  if(!journal||journal.version!==1||!uuid.test(journal.id)||!uuid.test(journal.installationId)||!['prepared','committed','rolled-back'].includes(journal.phase)||!['install','rollback'].includes(journal.operation)||typeof journal.dataRoot!=='string'||normalized(journal.dataRoot)!==normalized(transaction.dataRoot)||!validRelease(journal.next)||!sameFingerprint(journal.dataFingerprint,journal.dataFingerprint))throw fail('升级记录无效，已保留程序和数据。');
  if(journal.before){validateState(journal.before);if(journal.before.installationId!==journal.installationId||normalized(journal.before.dataRoot)!==normalized(transaction.dataRoot))throw fail('升级前记录不属于当前实例。');}
  if(current&&(current.installationId!==journal.installationId||normalized(current.dataRoot)!==normalized(transaction.dataRoot)||![journal.before?.current.id,journal.next.id].includes(current.current.id)))throw fail('安装状态在中断后已改变，不能自动覆盖。');
}
async function recoverLocked(transaction,data){
  const journal=await readJson(join(transaction.installRoot,journalName)),state=await installedState(transaction.installRoot);
  if(!journal){if(await optional(join(transaction.dataRoot,markerName)))throw fail('升级标记仍在但安装记录缺失，请保留文件并人工核对。');return {operation:'recover',recovered:false};}
  validateJournal(transaction,journal,state);
  if(journal.phase==='committed'){
    if(state?.current.id!==journal.next.id)throw fail('已提交的安装状态不一致，已保留现场。');
  }else if(journal.phase==='rolled-back'){
    if((state?.current.id??null)!==(journal.before?.current.id??null))throw fail('撤回后的安装状态不一致，请保留现场。');
  }else{
    if(!sameFingerprint(await data.fingerprint({uncancelled:true}),journal.dataFingerprint))throw fail('中断后数据已改变，不能自动覆盖；请保留新数据与加密恢复点。','UPGRADE_RECOVERY_REQUIRED');
    if(journal.before)await saveJson(join(transaction.installRoot,stateName),journal.before);else if(state)await rm(join(transaction.installRoot,stateName));
    await saveJson(join(transaction.installRoot,journalName),{...journal,phase:'rolled-back'});
  }
  await finish(transaction,journal);return {operation:'recover',recovered:true,committed:journal.phase==='committed'};
}
export async function recoverInstallation(options){return withInstallation(options,transaction=>withData(transaction,async data=>({...await recoverLocked(transaction,data),installRoot:transaction.installRoot,dataRoot:transaction.dataRoot})));}
async function copyLauncher(transaction,directory){
  for(const name of ['WhaleLauncher.exe','WhaleSetup.exe']){const target=join(transaction.installRoot,name),temporary=target+'.tmp-'+randomUUID();await cp(join(directory,name),temporary,{errorOnExist:true,force:false});
  try{for(let attempt=0;;attempt++){try{await rename(temporary,target);break;}catch(error){if(attempt>=15||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await new Promise(done=>setTimeout(done,100));}}}finally{await rm(temporary,{force:true});}
  }
}
async function commitActivation(transaction,data,journal,nextState,directory,options){
  await saveJson(join(transaction.installRoot,journalName),journal);await saveJson(join(transaction.dataRoot,markerName),{version:1,id:journal.id,installRoot:transaction.installRoot});options.checkpoint?.('prepared');
  try{
    await (options.check??checkRelease)(directory,transaction.dataRoot,transaction.signal);options.checkpoint?.('checked');
    if(!sameFingerprint(await data.fingerprint(),journal.dataFingerprint))throw fail('检查期间数据已改变，不能自动切换或覆盖。','UPGRADE_RECOVERY_REQUIRED');
    await copyLauncher(transaction,directory);await saveJson(join(transaction.installRoot,stateName),nextState);options.checkpoint?.('activated');
    await saveJson(join(transaction.installRoot,journalName),{...journal,phase:'committed'});options.checkpoint?.('committed');await finish(transaction,{...journal,phase:'committed'});
  }catch(error){try{await recoverLocked(transaction,data);}catch{throw fail('升级未收尾，程序和恢复点已保留；请在安装工具处理上次中断。','UPGRADE_RECOVERY_REQUIRED');}throw error;}
}
export async function installRelease(options){
  const {packageRoot,password,signal,onProgress=()=>{},repair=false}=options;signal?.throwIfAborted();
  return withInstallation(options,async transaction=>{
    if(await optional(join(transaction.installRoot,journalName))||await optional(join(transaction.dataRoot,markerName)))throw fail('上次安装升级未收尾，请先处理上次中断。','UPGRADE_RECOVERY_REQUIRED');
    assertNoPendingRestore(transaction.dataRoot);const before=await installedState(transaction.installRoot);
    if(before&&normalized(await canonicalRuntimePath(before.dataRoot))!==normalized(transaction.dataRoot))throw fail('此安装已绑定其它数据目录，不会静默切换实例。');
    if(!before){for(const name of await readdir(transaction.installRoot))if(!['releases','WhaleLauncher.exe','WhaleSetup.exe','.uninstalled.json','installation.qqbot-lock.sqlite','installation.qqbot-lock.sqlite-journal'].includes(name)&&!/^\.retired-[a-f0-9-]{36}$/.test(name))throw fail('目标目录包含其它文件，请选择新的专用安装目录。');}
    const source=await safeDirectory(packageRoot);if(inside(normalized(source),normalized(transaction.installRoot))||inside(normalized(transaction.installRoot),normalized(source)))throw fail('请选择安装目录之外的完整新发行包。');
    onProgress({stage:'package-verify',files:0,bytes:0});const checked=await verifyReleasePackage({packageRoot:source,trustFile:transaction.trustFile,signal,onProgress});
    if(!before){const retired=await readJson(join(transaction.installRoot,'.uninstalled.json'));for(const name of ['WhaleLauncher.exe','WhaleSetup.exe'])if(await optional(join(transaction.installRoot,name))){const actual=await releaseHash(join(transaction.installRoot,name));if(actual!==checked.manifest.files.find(file=>file.path===name).sha256&&!(retired?.appId==='whale-workbench'&&uuid.test(retired.installationId)&&retired.rootHashes?.[name]===actual))throw fail('目标目录中的启动器不属于所选发行，请选择新的专用目录。');}}
    if(before){const previousTrust=await loadReleaseTrust(transaction.trustFile),nextTrust=await loadReleaseTrust(join(source,'components/release-trust.json'));if(previousTrust.keys.some(key=>!nextTrust.keys.some(next=>next.id===key.id&&next.modulus===key.modulus&&next.exponent===key.exponent&&key.channels.every(channel=>next.channels.includes(channel)))))throw fail('新发行包未保留当前信任公钥，无法保证失败回退；请使用包含兼容公钥的发行包。');}
    if(repair&&before&&(checked.manifest.version!==before.current.version||checked.manifest.sourceRevision!==before.current.sourceRevision))throw fail('修复须选择与当前版本相同的完整发行包。');
    if(before&&checked.manifest.channel==='stable'){const numbers=value=>value.split('-')[0].split('.').map(Number),left=numbers(checked.manifest.version),right=numbers(before.current.version);let order=0;for(let i=0;i<3&&!order;i++)order=Math.sign(left[i]-right[i]);if(order<0)throw fail('不能用安装升级执行降级，请使用经过检查的回退入口。');}
    await mkdir(join(transaction.installRoot,'releases'),{recursive:true});if((await readdir(join(transaction.installRoot,'releases'))).length>=20)throw fail('保留的版本目录已达 20 个，请先核对并整理专用程序目录。');
    const space=await statfs(transaction.installRoot);if(space.bavail*space.bsize<checked.manifest.files.reduce((sum,file)=>sum+file.size,0)+64*1024*1024)throw fail('程序磁盘空间不足，旧版未切换。','ENOSPC');
    const next={id:randomUUID(),version:checked.manifest.version,sourceRevision:checked.manifest.sourceRevision,manifestSha256:checked.manifestSha256},directory=releasePath(transaction.installRoot,next);
    await cp(source,directory,{recursive:true,errorOnExist:true,force:false});const staged=await verifyReleasePackage({packageRoot:directory,trustFile:transaction.trustFile,signal,onProgress});if(staged.manifestSha256!==checked.manifestSha256)throw fail('复制期间发行来源发生变化，旧版未切换。');
    return withData(transaction,async data=>{
      signal?.throwIfAborted();let backup=null,backupSha256=null;const id=randomUUID();
      if(data.backup){onProgress({stage:'recovery-point',files:0,bytes:0});backup='install-'+id+'.wwbackup';await data.backup(join(transaction.dataRoot,'backups',backup),password);backupSha256=await releaseHash(join(transaction.dataRoot,'backups',backup),signal);}
      const dataFingerprint=await data.fingerprint(),installationId=before?.installationId??randomUUID(),journal={version:1,id,installationId,phase:'prepared',operation:'install',dataRoot:transaction.dataRoot,dataFingerprint,before,next};
      const nextState={formatVersion:1,appId:'whale-workbench',installationId,dataRoot:transaction.dataRoot,current:next,previous:before?.current??null,lastUpgrade:before?{dataFingerprint,backup,backupSha256}:null};
      onProgress({stage:'install-check',files:0,bytes:0});await commitActivation(transaction,data,journal,nextState,directory,options);return {operation:repair?'repair':'install',version:next.version,installRoot:transaction.installRoot,dataRoot:transaction.dataRoot,recoveryPoint:backup?join(transaction.dataRoot,'backups',backup):null};
    });
  });
}

/** Uninstall only verified program files; configuration, credentials and backups stay in dataRoot. */
export async function uninstallInstallation(options){
  return withInstallation(options,async transaction=>{
    assertNoPendingRestore(transaction.dataRoot);if(await optional(join(transaction.installRoot,journalName)))throw fail('请先处理安装升级中断。');
    const saved=await readJson(join(transaction.installRoot,'.uninstalled.json'));let state=await installedState(transaction.installRoot);if(!state){if(saved?.appId!=='whale-workbench'||!uuid.test(saved.installationId))throw fail('此目录没有可卸载的已安装程序。');state=validateState(saved.state);}
    if(normalized(state.dataRoot)!==normalized(transaction.dataRoot))throw fail('所选数据目录与已安装实例不一致。');
    if(inside(normalized(transaction.installRoot),normalized(transaction.root)))throw fail('请使用独立卸载工具退出已安装程序后再卸载。');
    return withData(transaction,async()=>{
      const releaseDirectory=join(transaction.installRoot,'releases'),retiredName=saved?.installationId===state.installationId&&/^\.retired-[a-f0-9-]{36}$/.test(saved.retiredName)?saved.retiredName:'.retired-'+randomUUID(),retired=join(transaction.installRoot,retiredName),source=await optional(releaseDirectory)?releaseDirectory:retired;
      const owned=[];if(await optional(source)){for(const name of await readdir(source)){options.signal?.throwIfAborted();if(!uuid.test(name))continue;try{const checked=await verifyReleasePackage({packageRoot:join(source,name),trustFile:transaction.trustFile,signal:options.signal});owned.push({name,manifest:checked.manifest,metadataFiles:await Promise.all(['release-integrity.json','release-integrity.sig.json'].map(async path=>({path,sha256:await releaseHash(join(source,name,path))})))});}catch(error){options.signal?.throwIfAborted();if(name===state.current.id)throw error;}}}
      const rootHashes={};for(const name of ['WhaleLauncher.exe','WhaleSetup.exe'])if(await optional(join(transaction.installRoot,name)))rootHashes[name]=await releaseHash(join(transaction.installRoot,name),options.signal);
      await saveJson(join(transaction.installRoot,'.uninstalled.json'),{formatVersion:1,appId:'whale-workbench',installationId:state.installationId,dataRoot:transaction.dataRoot,state,retiredName,rootHashes});
      options.signal?.throwIfAborted();await rm(join(transaction.installRoot,stateName),{force:true});
      if(source===releaseDirectory){if(await optional(retired))throw fail('卸载保留目录已经存在，程序已停用，资料未删除。');await rename(releaseDirectory,retired);}
      let removed=0;for(const entry of owned){const directory=join(retired,entry.name),folders=new Set([directory]);
        for(const file of [...entry.manifest.files,...entry.metadataFiles]){const path=join(directory,file.path);for(let parent=dirname(path);inside(directory,parent);parent=dirname(parent)){folders.add(parent);if(parent===directory)break;}try{const item=await optional(path);if(!item)continue;if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1||file.sha256&&await releaseHash(path)!==file.sha256)continue;await rm(path);removed++;}catch{}}
        for(const folder of [...folders].sort((a,b)=>b.length-a.length))try{if(!(await readdir(folder)).length)await rmdir(folder);}catch{}
      }
      try{if(!(await readdir(retired)).length)await rmdir(retired);}catch{}
      return {operation:'uninstall',installRoot:transaction.installRoot,dataRoot:transaction.dataRoot,dataPreserved:true,removedProgramFiles:removed,retiredDirectory:await optional(retired)?retired:null};
    });
  });
}
export async function rollbackInstallation(options){
  return withInstallation(options,async transaction=>{
    assertNoPendingRestore(transaction.dataRoot);if(await optional(join(transaction.installRoot,journalName)))throw fail('请先处理安装升级中断。');
    const before=await installedState(transaction.installRoot);if(!before?.previous||!before.lastUpgrade||normalized(before.dataRoot)!==normalized(transaction.dataRoot))throw fail('没有可配对回退的上一版本。');
    const directory=releasePath(transaction.installRoot,before.previous),checked=await verifyReleasePackage({packageRoot:directory,trustFile:transaction.trustFile,signal:options.signal});if(checked.manifestSha256!==before.previous.manifestSha256)throw fail('上一版本文件已改变，不能回退。');
    return withData(transaction,async data=>{
      const dataFingerprint=await data.fingerprint();if(!sameFingerprint(dataFingerprint,before.lastUpgrade.dataFingerprint))throw fail('新版本已产生或修改数据，不能用旧备份自动覆盖；请先保留新数据并人工核对。','ROLLBACK_DATA_CHANGED');
      if(before.lastUpgrade.backup){const file=join(transaction.dataRoot,'backups',before.lastUpgrade.backup);if(await releaseHash(file,options.signal)!==before.lastUpgrade.backupSha256)throw fail('配对恢复点已改变，不能回退。');await verifyBackup({file,password:options.password,signal:options.signal});}
      const journal={version:1,id:randomUUID(),installationId:before.installationId,phase:'prepared',operation:'rollback',dataRoot:transaction.dataRoot,dataFingerprint,before,next:before.previous},nextState={...before,current:before.previous,previous:null,lastUpgrade:null};
      await commitActivation(transaction,data,journal,nextState,directory,options);return {operation:'rollback',installRoot:transaction.installRoot,dataRoot:transaction.dataRoot,version:nextState.current.version,dataUnchanged:true};
    });
  });
}
