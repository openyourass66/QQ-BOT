import {readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';

const names={manifest:'release-integrity.json',signature:'release-integrity.sig.json'},maxBytes=6*1024*1024;
const invalid=message=>Object.assign(new Error(message),{code:'RELEASE_UNTRUSTED'});
export const releasePlatform=`${process.platform}-${process.arch}`;
const requiredEntries={
  'win32-x64':['QQ-BOT.exe','WhaleSetup.exe','WhaleLauncher.exe','runtime/node.exe','scripts/install-worker.mjs','components/release-trust.json','release-manifest.json'],
  'linux-x64':['runtime/bin/node','scripts/whaled.mjs','scripts/remote-host.mjs','scripts/runtime-service.mjs','scripts/maintenance.mjs','scripts/install-check.mjs','desktop/runtime-fields.mjs','release-manifest.json']
};
export function releaseFileName(value){return typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\\<>:"|?*\x00-\x1f]/u.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part));}
export async function releaseHash(path,signal){const digest=createHash('sha256');for await(const chunk of createReadStream(path)){signal?.throwIfAborted();digest.update(chunk);}return digest.digest('hex');}
async function safeFile(path,max=Infinity){const state=await lstat(path);if(!state.isFile()||state.isSymbolicLink()||state.nlink!==1||state.size>max)throw invalid('发行文件类型或大小无效。');return state;}
async function readLimited(path,max=maxBytes){await safeFile(path,max);return readFile(path);}
async function safeRoot(root){root=resolve(root);for(let path=root;;path=dirname(path)){if((await lstat(path)).isSymbolicLink())throw invalid('发行目录不能使用链接路径。');if(dirname(path)===path)break;}return root;}
export async function releaseInventory(root,{signal,onProgress=()=>{}}={}){
  root=await safeRoot(root);const files=[],seen=new Set();let bytes=0;
  const walk=async(directory,prefix='',depth=0)=>{
    if(depth>32)throw invalid('发行目录层级过深。');
    for(const name of (await readdir(directory)).sort()){
      signal?.throwIfAborted();const path=join(directory,name),relativeName=prefix+name,state=await lstat(path),key=relativeName.toLowerCase();
      if(!releaseFileName(relativeName)||seen.has(key)||state.isSymbolicLink())throw invalid('发行目录包含链接或冲突路径。');seen.add(key);
      if(state.isDirectory()){await walk(path,relativeName+'/',depth+1);continue;}
      await safeFile(path);if(Object.values(names).includes(relativeName))continue;
      if(files.length>=30000||state.size>1024**3||(bytes+=state.size)>4*1024**3)throw invalid('发行文件数量或大小超出支持范围。');
      files.push({path:relativeName,size:state.size,sha256:await releaseHash(path,signal)});onProgress({stage:'package-verify',files:files.length,bytes});
    }
  };await walk(root);return files;
}
export async function loadReleaseTrust(path){
  let trust;try{trust=JSON.parse((await readLimited(path,65536)).toString('utf8'));}catch{throw invalid('发行信任清单缺失或损坏，不能安装或更新。');}
  if(trust.formatVersion!==1||!Array.isArray(trust.keys)||trust.keys.length>10)throw invalid('发行信任清单格式无效。');
  const ids=new Set();for(const key of trust.keys){if(!key||!/^[a-zA-Z0-9_-]{1,48}$/.test(key.id)||ids.has(key.id)||key.algorithm!=='rsa-sha256'||typeof key.modulus!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(key.modulus)||Buffer.from(key.modulus,'base64').length<384||Buffer.from(key.modulus,'base64').length>1024||key.exponent!=='AQAB'||!Array.isArray(key.channels)||!key.channels.length||key.channels.some(channel=>!['internal-validation','stable'].includes(channel)))throw invalid('发行公钥格式无效。');ids.add(key.id);}
  return trust;
}
function publicKey(key){return createPublicKey({key:{kty:'RSA',n:Buffer.from(key.modulus,'base64').toString('base64url'),e:Buffer.from(key.exponent,'base64').toString('base64url')},format:'jwk'});}
function validateManifest(manifest){
  const required=requiredEntries[releasePlatform];
  if(!required)throw invalid('当前平台不受发行安装支持。');
  if(manifest.formatVersion!==1||manifest.appId!=='whale-workbench'||manifest.platform!==releasePlatform||!['stable','internal-validation'].includes(manifest.channel)||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?$/.test(manifest.version)||! /^[a-f0-9]{40,64}$/.test(manifest.sourceRevision)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>30000)throw invalid('发行完整性清单格式无效。');
  const seen=new Set();let bytes=0;for(const file of manifest.files){if(!releaseFileName(file.path)||seen.has(file.path.toLowerCase())||Object.values(names).includes(file.path)||!Number.isSafeInteger(file.size)||file.size<0||file.size>1024**3||(bytes+=file.size)>4*1024**3||! /^[a-f0-9]{64}$/.test(file.sha256))throw invalid('发行文件清单包含无效记录。');seen.add(file.path.toLowerCase());}
  for(const file of required)if(!seen.has(file.toLowerCase()))throw invalid('发行完整性清单缺少必需入口。');
  if(manifest.files.some(file=>/^(?:\.env(?:$|\/)|bot\.config\.json(?:$|\/)|data\/|user-data\/|napcat\/|dsh\/|\.credentials\/|bot-workspace\/)/i.test(file.path)))throw invalid('发行清单不能包含个人数据。');
}
export async function verifyReleasePackage({packageRoot,trustFile,signal,onProgress}){
  packageRoot=await safeRoot(packageRoot);const trust=await loadReleaseTrust(trustFile);let raw,signature,manifest;
  try{raw=await readLimited(join(packageRoot,names.manifest));signature=JSON.parse((await readLimited(join(packageRoot,names.signature),8192)).toString('utf8'));manifest=JSON.parse(raw.toString('utf8'));}catch{throw invalid('发行签名文件缺失或损坏，不能安装或更新。');}
  validateManifest(manifest);const key=trust.keys.find(key=>key.id===signature.keyId&&key.channels.includes(manifest.channel));
  if(!key||typeof signature.signature!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(signature.signature)||!verify('sha256',raw,publicKey(key),Buffer.from(signature.signature,'base64')))throw invalid('发行签名不属于已信任的发布者，已拒绝安装或更新。');
  const actual=await releaseInventory(packageRoot,{signal,onProgress});if(actual.length!==manifest.files.length)throw invalid('发行包存在缺失或未登记文件。');
  const expected=new Map(manifest.files.map(file=>[file.path,file]));for(const file of actual){const item=expected.get(file.path);if(!item||item.size!==file.size||item.sha256!==file.sha256)throw invalid('发行包文件摘要不匹配，已拒绝安装或更新。');}
  const release=JSON.parse((await readLimited(join(packageRoot,'release-manifest.json'),65536)).toString('utf8'));if(release.appId!==manifest.appId||release.version!==manifest.version||release.sourceRevision!==manifest.sourceRevision||release.channel!==manifest.channel)throw invalid('发行来源记录与签名清单不一致。');
  return {manifest,manifestSha256:createHash('sha256').update(raw).digest('hex'),keyId:key.id};
}
export async function signReleasePackage({packageRoot,privateKeyFile,keyId,trustFile}){
  const trust=await loadReleaseTrust(trustFile),key=trust.keys.find(key=>key.id===keyId);if(!key)throw invalid('签名公钥未列入发行信任清单。');
  const privateKey=createPrivateKey(await readLimited(privateKeyFile,32768)),pub=createPublicKey(privateKey).export({format:'jwk'});if(pub.kty!=='RSA'||pub.n!==publicKey(key).export({format:'jwk'}).n)throw invalid('发行私钥与所选公钥不匹配。');
  const release=JSON.parse((await readLimited(join(packageRoot,'release-manifest.json'),65536)).toString('utf8')),manifest={formatVersion:1,appId:'whale-workbench',platform:releasePlatform,version:release.version,channel:release.channel,sourceRevision:release.sourceRevision,files:await releaseInventory(packageRoot)};validateManifest(manifest);if(!key.channels.includes(manifest.channel))throw invalid('此公钥不允许签发所选发行通道。');
  const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');if(raw.length>maxBytes)throw invalid('发行清单过大。');await writeFile(join(packageRoot,names.manifest),raw,{flag:'wx'});await writeFile(join(packageRoot,names.signature),JSON.stringify({keyId,signature:sign('sha256',raw,privateKey).toString('base64')})+'\n',{flag:'wx'});
  return verifyReleasePackage({packageRoot,trustFile});
}
