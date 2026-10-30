import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir,lstat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {installRelease,installedState,rollbackInstallation,recoverInstallation,uninstallInstallation} from '../scripts/installer-core.mjs';
import {assertNoPendingRestore,prepareRuntime} from '../scripts/app-paths.mjs';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {releaseFixture} from './helpers/releases.mjs';

async function existing(dataRoot){await mkdir(join(dataRoot,'bot-workspace'),{recursive:true});await writeFile(join(dataRoot,'.env'),'BOT_WORKSPACE=bot-workspace\nONEBOT_TOKEN=fixture-original-private\n');await writeFile(join(dataRoot,'bot-workspace/AGENTS.md'),'fixture-persona');}
async function crash(options,stage){
  const module=pathToFileURL(resolve('scripts/installer-core.mjs')).href,child=spawn(process.execPath,['--input-type=module','-e',`import{installRelease}from ${JSON.stringify(module)};let input='';for await(const chunk of process.stdin)input+=chunk;await installRelease({...JSON.parse(input),check:async()=>{},checkpoint:stage=>{if(stage===${JSON.stringify(stage)})process.exit(42);}});`],{windowsHide:true,stdio:['pipe','ignore','pipe']});let error='';child.stderr.on('data',chunk=>error+=chunk);child.stdin.end(JSON.stringify(options));assert.equal((await once(child,'exit'))[0],42,error);
}
test('用户级安装保持数据分离，升级保存恢复点且未写新数据时可配对回退',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  const first=await make('first'),second=await make('second',{revision:'2'.repeat(40)});await installRelease({...options,packageRoot:first});let state=await installedState(installRoot);assert.equal(state.current.sourceRevision,'1'.repeat(40));assert.equal(state.previous,null);await assert.rejects(lstat(join(dataRoot,'.env')),{code:'ENOENT'});
  await existing(dataRoot);const upgraded=await installRelease({...options,packageRoot:second});state=await installedState(installRoot);assert.equal(state.current.sourceRevision,'2'.repeat(40));assert.equal(state.previous.sourceRevision,'1'.repeat(40));assert.ok((await lstat(upgraded.recoveryPoint)).size>100);
  const result=await rollbackInstallation(options);assert.equal(result.dataUnchanged,true);assert.equal((await installedState(installRoot)).current.sourceRevision,'1'.repeat(40));assert.match(await readFile(join(dataRoot,'.env'),'utf8'),/fixture-original-private/);
}));
test('新版本产生数据、恢复点损坏或密码错误时拒绝回退，不覆盖现有资料',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  await existing(dataRoot);await installRelease({...options,packageRoot:await make('first')});const result=await installRelease({...options,packageRoot:await make('second',{revision:'2'.repeat(40)})});await assert.rejects(rollbackInstallation({...options,password:'fixture-incorrect-password'}),/密码错误|损坏/);
  const original=await readFile(join(dataRoot,'.env'),'utf8');await writeFile(join(dataRoot,'.env'),original+'\n# new-user-data\n');await assert.rejects(rollbackInstallation(options),{code:'ROLLBACK_DATA_CHANGED'});assert.match(await readFile(join(dataRoot,'.env'),'utf8'),/new-user-data/);await writeFile(join(dataRoot,'.env'),original);await writeFile(result.recoveryPoint,'tampered');await assert.rejects(rollbackInstallation(options),/恢复点已改变/);assert.equal((await installedState(installRoot)).current.sourceRevision,'2'.repeat(40));
}));
test('检查失败或激活后异常自动撤回指针，保留旧程序和用户资料',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  await existing(dataRoot);await installRelease({...options,packageRoot:await make('first')});const before=await installedState(installRoot),second=await make('second',{revision:'2'.repeat(40)});
  await assert.rejects(installRelease({...options,packageRoot:second,check:async()=>{throw Error('fixture-check-failure');}}),/fixture-check-failure/);assert.equal((await installedState(installRoot)).current.id,before.current.id);
  await assert.rejects(installRelease({...options,packageRoot:second,checkpoint:stage=>{if(stage==='activated')throw Error('fixture-activation-failure');}}),/fixture-activation-failure/);assert.equal((await installedState(installRoot)).current.id,before.current.id);assert.doesNotThrow(()=>assertNoPendingRestore(dataRoot));
}));
for(const stage of ['prepared','activated','committed'])test('安装宿主在 '+stage+' 退出后按提交状态恢复',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  await existing(dataRoot);await installRelease({...options,packageRoot:await make('first')});const before=await installedState(installRoot),packageRoot=await make('second',{revision:'2'.repeat(40)});await crash({...options,check:undefined,packageRoot},stage);
  assert.throws(()=>assertNoPendingRestore(dataRoot),{code:'UPGRADE_RECOVERY_REQUIRED'});assert.throws(()=>mutableDataResources(dataPaths({},dataRoot)),{code:'UPGRADE_RECOVERY_REQUIRED'});const recovered=await recoverInstallation(options);assert.equal(recovered.committed,stage==='committed');assert.equal((await installedState(installRoot)).current.sourceRevision,stage==='committed'?'2'.repeat(40):before.current.sourceRevision);assert.doesNotThrow(()=>assertNoPendingRestore(dataRoot));
}));
test('中断后人工修改数据不自动回退，篡改的程序路径不参与恢复',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  await existing(dataRoot);await installRelease({...options,packageRoot:await make('first')});await crash({...options,check:undefined,packageRoot:await make('second',{revision:'2'.repeat(40)})},'activated');const file=join(dataRoot,'.env'),original=await readFile(file,'utf8');await writeFile(file,original+'\n# keep-manual\n');await assert.rejects(recoverInstallation(options),{code:'UPGRADE_RECOVERY_REQUIRED'});assert.match(await readFile(file,'utf8'),/keep-manual/);await writeFile(file,original);
  const journalPath=join(installRoot,'.install-journal.json'),raw=await readFile(journalPath,'utf8'),journal=JSON.parse(raw);journal.next.id='../../outside';await writeFile(journalPath,JSON.stringify(journal));await assert.rejects(recoverInstallation(options),/无效/);await writeFile(journalPath,raw);await recoverInstallation(options);
}));
test('实例运行、目录交叠、无关文件及不匹配修复包均拒绝',()=>releaseFixture(async({options,make,installRoot,dataRoot,fixture})=>{
  const packageRoot=await make('app');await assert.rejects(installRelease({...options,packageRoot,installRoot:join(dataRoot,'app')}),/独立/);await mkdir(installRoot,{recursive:true});await writeFile(join(installRoot,'user.txt'),'keep');await assert.rejects(installRelease({...options,packageRoot}),/其它文件/);assert.equal(await readFile(join(installRoot,'user.txt'),'utf8'),'keep');await rm(join(installRoot,'user.txt'));
  const lease=await acquireDataResources([{path:join(dataRoot,'data/runtime-control'),label:'test runtime'}]);try{await assert.rejects(installRelease({...options,packageRoot}),{code:'BOT_RESOURCE_LOCKED'});}finally{lease.release();}await installRelease({...options,packageRoot});await assert.rejects(installRelease({...options,packageRoot:await make('new',{revision:'2'.repeat(40)}),repair:true}),/修复须选择/);
}));

test('首次安装激活时退出，可从独立工具撤回并在原目录重新安装',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  const packageRoot=await make('app');await crash({...options,check:undefined,packageRoot},'activated');await prepareRuntime({root:resolve('.'),args:['--data-dir',dataRoot]});await assert.rejects(lstat(join(dataRoot,'.env')),{code:'ENOENT'});await recoverInstallation(options);assert.equal(await installedState(installRoot),null);await installRelease({...options,packageRoot});assert.ok((await installedState(installRoot)).current);
}));

test('独立卸载只删除验证后的程序文件，保留数据与备份并允许重新安装',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  const packageRoot=await make('app');await existing(dataRoot);await installRelease({...options,packageRoot});await mkdir(join(dataRoot,'backups'),{recursive:true});await writeFile(join(dataRoot,'backups/user-backup.wwbackup'),'fixture-user-backup');
  const result=await uninstallInstallation(options);assert.equal(result.dataPreserved,true);assert.ok(result.removedProgramFiles>0);assert.equal(await installedState(installRoot),null);assert.match(await readFile(join(dataRoot,'.env'),'utf8'),/fixture-original-private/);assert.equal(await readFile(join(dataRoot,'backups/user-backup.wwbackup'),'utf8'),'fixture-user-backup');await installRelease({...options,packageRoot});assert.ok(await installedState(installRoot));
}));

test('卸载拒绝正在运行的程序目录，未知文件导致验证失败时保留安装状态',()=>releaseFixture(async({options,make,installRoot,dataRoot})=>{
  await installRelease({...options,packageRoot:await make('app')});const current=await installedState(installRoot),directory=join(installRoot,'releases',current.current.id);await assert.rejects(uninstallInstallation({...options,root:directory}),/独立卸载/);await writeFile(join(directory,'user-data.txt'),'keep');await assert.rejects(uninstallInstallation(options),/未登记/);assert.ok(await installedState(installRoot));assert.equal(await readFile(join(directory,'user-data.txt'),'utf8'),'keep');
}));
