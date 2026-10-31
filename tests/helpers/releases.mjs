import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {signReleasePackage} from '../../scripts/release-integrity.mjs';

const pair=generateKeyPairSync('rsa',{modulusLength:3072}),jwk=pair.publicKey.export({format:'jwk'});
// 安装器测试使用 Windows 启动器名称；同时放入两平台必需入口，保证同一夹具在 Windows 与 Linux 上都能真实验签。
const fixtureFiles=['QQ-BOT.exe','WhaleSetup.exe','WhaleLauncher.exe','runtime/node.exe','scripts/install-worker.mjs','runtime/bin/node','scripts/whaled.mjs','scripts/remote-host.mjs','scripts/runtime-service.mjs','scripts/maintenance.mjs','scripts/install-check.mjs','desktop/runtime-fields.mjs'];
export const testTrust={formatVersion:1,keys:[{id:'fixture-test',algorithm:'rsa-sha256',modulus:Buffer.from(jwk.n,'base64url').toString('base64'),exponent:'AQAB',channels:['internal-validation','stable']}]};
export async function releaseFixture(run){
  const parent=await realpath(tmpdir()),fixture=await mkdtemp(join(parent,'qq-installer-test-')),root=join(fixture,'trusted-host'),installRoot=join(fixture,'installed'),dataRoot=join(fixture,'data'),privateKeyFile=join(fixture,'test-key.pem'),trustFile=join(root,'components/release-trust.json');
  try{
    await mkdir(dirname(trustFile),{recursive:true});await writeFile(trustFile,JSON.stringify(testTrust));await writeFile(privateKeyFile,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    const make=async(name,{version='0.2.0',revision='1'.repeat(40),channel='internal-validation'}={})=>{
      const packageRoot=join(fixture,name);for(const file of fixtureFiles){await mkdir(dirname(join(packageRoot,file)),{recursive:true});await writeFile(join(packageRoot,file),'fixture-content-'+name+'-'+file);}
      await mkdir(join(packageRoot,'components'));await writeFile(join(packageRoot,'components/release-trust.json'),JSON.stringify(testTrust));await writeFile(join(packageRoot,'release-manifest.json'),JSON.stringify({formatVersion:1,appId:'whale-workbench',version,channel,sourceRevision:revision}));
      await signReleasePackage({packageRoot,privateKeyFile,keyId:'fixture-test',trustFile});return packageRoot;
    };
    await run({fixture,root,installRoot,dataRoot,privateKeyFile,trustFile,make,options:{root,installRoot,dataRoot,password:'fixture-install-backup-password',check:async()=>{}}});
  }finally{const actual=await realpath(fixture);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('qq-installer-test-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}
