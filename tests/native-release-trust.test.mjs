import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {releaseFixture} from './helpers/releases.mjs';
import {signReleasePackage} from '../scripts/release-integrity.mjs';

async function run(file,args){const child=spawn(file,args,{windowsHide:true,stdio:'ignore'}),timer=setTimeout(()=>child.kill(),20000);try{return (await once(child,'exit'))[0];}finally{clearTimeout(timer);}}
test('原生安装器使用编译时公钥验证真实 RSA 签名并拒绝文件篡改',{skip:process.platform!=='win32'},()=>releaseFixture(async({fixture,make,privateKeyFile,trustFile})=>{
  const packageRoot=await make('native');assert.equal(await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('desktop/build-installer.ps1'),'-TrustFile',trustFile,'-OutputDirectory',packageRoot]),0);
  for(const file of ['release-integrity.json','release-integrity.sig.json'])await rm(join(packageRoot,file));await signReleasePackage({packageRoot,privateKeyFile,keyId:'fixture-test',trustFile});const result=join(fixture,'result.txt');
  assert.equal(await run(join(packageRoot,'WhaleSetup.exe'),['--verify',packageRoot,'--result',result]),0,await readFile(result,'utf8').catch(()=>''));assert.equal(await readFile(result,'utf8'),'PASS');
  await writeFile(join(packageRoot,'runtime/node.exe'),'tampered');assert.equal(await run(join(packageRoot,'WhaleSetup.exe'),['--verify',packageRoot,'--result',result]),1);assert.equal(await readFile(result,'utf8'),'FAIL');
}));
