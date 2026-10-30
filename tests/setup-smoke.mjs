import {cp,readFile,writeFile,mkdir,rm,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {releaseFixture,testTrust} from './helpers/releases.mjs';
import {releaseScripts} from '../scripts/release-validation.mjs';
import {signReleasePackage,verifyReleasePackage} from '../scripts/release-integrity.mjs';
import {installedState} from '../scripts/installer-core.mjs';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';

if(process.platform!=='win32')throw Error('原生安装工具检查仅支持 Windows');
const {values}=parseArgs({options:{package:{type:'string'},output:{type:'string'}}});if(!values.package)throw Error('需要 --package 指定已有完整候选目录');
async function run(executable,args,timeout=90000){
  const env={...process.env};for(const key of Object.keys(env))if(/^(NODE_OPTIONS|NODE_PATH|BOT_|ONEBOT_|QQ_BOT_|SESSION_STORE$)/.test(key))delete env[key];
  const child=spawn(executable,args,{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let errors='';child.stdout.resume();child.stderr.on('data',chunk=>errors=(errors+chunk).slice(-4000));const timer=setTimeout(()=>child.kill(),timeout);try{const [code]=await once(child,'exit');assert.equal(code,0,errors);}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
const report={kind:'synthetic-native-installer-smoke',temporarySigningKey:true,realUserData:false,formalPublisherIdentity:false,steps:[]};
await releaseFixture(async({fixture,root,installRoot,dataRoot,privateKeyFile,trustFile})=>{
  const app=join(fixture,'完整 发行'),source=resolve('.');console.error('准备完整隔离发行夹具…');await cp(resolve(values.package),app,{recursive:true,errorOnExist:true,force:false});
  for(const file of releaseScripts)await cp(join(source,'scripts',file),join(app,'scripts',file));await cp(join(source,'dist'),join(app,'dist'),{recursive:true,force:true});await cp(trustFile,join(app,'components/release-trust.json'));
  await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(source,'desktop/build-installer.ps1'),'-TrustFile',trustFile,'-OutputDirectory',app]);
  const manifestPath=join(app,'release-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.version='0.2.0';manifest.channel='internal-validation';manifest.sourceRevision='1'.repeat(40);await writeFile(manifestPath,JSON.stringify(manifest));
  const resign=async()=>{for(const file of ['release-integrity.json','release-integrity.sig.json'])await rm(join(app,file),{force:true});await signReleasePackage({packageRoot:app,privateKeyFile,keyId:'fixture-test',trustFile});};await resign();
  const verified=join(fixture,'native-verify.txt');console.error('检查原生签名与完整文件…');await run(join(app,'WhaleSetup.exe'),['--verify',app,'--result',verified]);assert.equal(await readFile(verified,'utf8'),'PASS');report.steps.push('native-signature-and-full-file-verification');
  const requestPath=join(fixture,'request.json'),resultPath=join(fixture,'setup-smoke-result.json');
  const gui=async(operation)=>{console.error('检查原生操作：'+operation);await rm(resultPath,{force:true});await writeFile(requestPath,JSON.stringify({operation,packageRoot:app,installRoot,dataRoot,password:'中文-fixture-install-backup-password'}));await run(join(app,'WhaleSetup.exe'),['--smoke',requestPath],300000);const result=JSON.parse(await readFile(resultPath,'utf8'));assert.equal(result.ok,true,result.text);assert.equal(result.bindings.registered,operation!=='uninstall','isolated registry entry');assert.equal(result.bindings.shortcut,operation!=='uninstall','isolated shortcut');report.steps.push('native-'+operation);};
  await gui('install');assert.equal((await installedState(installRoot)).current.sourceRevision,'1'.repeat(40));await assert.rejects(lstat(join(dataRoot,'.env')),{code:'ENOENT'});
  await mkdir(join(dataRoot,'bot-workspace'),{recursive:true});await writeFile(join(dataRoot,'.env'),'BOT_WORKSPACE=bot-workspace\nBOT_ONEBOT_MODE=external\nONEBOT_HTTP_URL=http://127.0.0.1:1\nONEBOT_WS_URL=ws://127.0.0.1:1\n');await writeFile(join(dataRoot,'bot-workspace/AGENTS.md'),'synthetic-persona');
  const social=new SqliteSocialStore(join(dataRoot,'data/social.json')),usage=new SqliteDailyUsageStore(join(dataRoot,'data/daily-usage.json'));try{await social.load();await usage.load();}finally{await social.close();await usage.close();}
  manifest.version='0.2.1';manifest.sourceRevision='2'.repeat(40);await writeFile(manifestPath,JSON.stringify(manifest));await resign();await gui('install');assert.equal((await installedState(installRoot)).current.sourceRevision,'2'.repeat(40));await gui('rollback');assert.equal((await installedState(installRoot)).current.sourceRevision,'1'.repeat(40));
  manifest.version='0.2.0';manifest.sourceRevision='1'.repeat(40);await writeFile(manifestPath,JSON.stringify(manifest));await resign();const current=await installedState(installRoot),currentRoot=join(installRoot,'releases',current.current.id);await writeFile(join(currentRoot,'QQ-BOT.exe'),'fixture-corrupt-program');await gui('repair');const repaired=await installedState(installRoot);await verifyReleasePackage({packageRoot:join(installRoot,'releases',repaired.current.id),trustFile});
  await gui('uninstall');assert.equal(await installedState(installRoot),null);assert.match(await readFile(join(dataRoot,'.env'),'utf8'),/BOT_WORKSPACE/);
  if(values.output){await mkdir(resolve(values.output),{recursive:true});await cp(join(fixture,'setup-smoke.png'),join(resolve(values.output),'setup-smoke.png'));}
});
report.passed=true;if(values.output)await writeFile(join(resolve(values.output),'setup-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
