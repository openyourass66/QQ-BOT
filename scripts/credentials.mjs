import {spawn} from 'node:child_process';
import {mkdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {replaceEnvAssignments} from './env-file.mjs';

export const credentialKeys=['ONEBOT_TOKEN','QQ_BOT_DEEPSEEK_API_KEY','BOT_MEDIA_API_KEY','BOT_LEARNING_API_KEY'];
const prefix='@whale-credential:',reference=/^@whale-credential:([a-f0-9]{32})$/;
const cache=new Map();
const failure=()=>new Error('Windows 凭据不可读取，请使用原 Windows 用户打开，或在连接设置中重新输入密钥。');
const script=`$ErrorActionPreference='Stop';try{Add-Type -AssemblyName System.Security;$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$entropy=[Text.Encoding]::UTF8.GetBytes('WhaleWorkbench.Credentials.v1');$result=@();foreach($value in $r.values){$bytes=[Convert]::FromBase64String($value);if($r.operation -eq 'protect'){$bytes=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}elseif($r.operation -eq 'unprotect'){$bytes=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{throw 'invalid operation'};$result+=,[Convert]::ToBase64String($bytes)};[Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress))}catch{[Console]::Error.Write('Windows credential operation failed');exit 1}`;

async function crypt(operation,values) {
  if(!values.length)return [];
  if(process.platform!=='win32')throw failure();
  return new Promise((done,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramFiles|ProgramData|HOMEDRIVE|HOMEPATH|PSModulePath)$/i.test(key)));
    const executable=join(process.env.SystemRoot||process.env.WINDIR||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child=spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(failure()):done(result);};
    const timer=setTimeout(()=>{child.kill();finish(true);},10000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>262144){child.kill();finish(true);}});child.stderr.resume();
    child.once('error',()=>finish(true));child.once('close',code=>{
      try{if(code!==0)throw new Error();const result=JSON.parse(output);if(!Array.isArray(result)||result.length!==values.length||result.some(value=>typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)))throw new Error();finish(false,result.map(value=>Buffer.from(value,'base64')));}catch{finish(true);}
    });
    child.stdin.on('error',()=>finish(true));child.stdin.end(JSON.stringify({operation,values:values.map(value=>Buffer.from(value).toString('base64'))}));
  });
}

export async function resolveCredentialEnv(dataRoot,values,{allowUnavailable=false}={}) {
  const next={...values},pending=[];
  for(const key of credentialKeys) {
    if(!next[key]?.startsWith(prefix))continue;
    const match=reference.exec(next[key]);if(!match){if(allowUnavailable){next[key]='';continue;}throw failure();}
    const path=join(resolve(dataRoot),'.credentials',match[1]+'.json');
    try {
      const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>65536)throw new Error();
      const raw=await readFile(path,'utf8'),record=JSON.parse(raw);
      if(record.version!==1||record.kind!=='secret'||typeof record.ciphertext!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext))throw new Error();
      const token=path+':'+createHash('sha256').update(raw).digest('hex');
      if(cache.has(token))next[key]=cache.get(token);else pending.push({key,token,bytes:Buffer.from(record.ciphertext,'base64')});
    }catch{if(allowUnavailable){next[key]='';continue;}throw failure();}
  }
  let plaintext;
  try{plaintext=await crypt('unprotect',pending.map(item=>item.bytes));}
  catch(error){if(!allowUnavailable)throw error;plaintext=await Promise.all(pending.map(async item=>{try{return (await crypt('unprotect',[item.bytes]))[0];}catch{return undefined;}}));}
  for(let index=0;index<pending.length;index++){const item=pending[index];next[item.key]=plaintext[index]?.toString('utf8')??'';if(plaintext[index])cache.set(item.token,next[item.key]);}
  while(cache.size>64)cache.delete(cache.keys().next().value);
  return next;
}

/** 普通发行模式保存凭据引用；已保护的配置不会因从源码打开而降级为明文。 */
export async function protectEnvironmentText(dataRoot,text,previous='',{protectedMode=process.env.BOT_CREDENTIAL_MODE==='dpapi'}={}) {
  const values=parseEnv(text.replace(/^\uFEFF/,'')),before=parseEnv(previous.replace(/^\uFEFF/,''));
  const enabled=protectedMode||credentialKeys.some(key=>values[key]?.startsWith(prefix)||before[key]?.startsWith(prefix));
  if(!enabled)return text;
  await resolveCredentialEnv(dataRoot,values);
  const previousValues=await resolveCredentialEnv(dataRoot,before,{allowUnavailable:true}),changes={};
  for(const key of credentialKeys)if(values[key]){
    if(values[key].startsWith(prefix)){if(!reference.test(values[key]))throw failure();changes[key]=values[key];}
    else if(reference.test(before[key]||'')&&values[key]===previousValues[key])changes[key]=before[key];
    else changes[key]=null;
  }
  const keys=Object.keys(changes).filter(key=>changes[key]===null);
  const backup=credentialKeys.some(key=>before[key]&&!before[key].startsWith(prefix));
  const plaintext=[...keys.map(key=>Buffer.from(values[key])),...(backup?[Buffer.from(previous)]:[])];
  const encrypted=await crypt('protect',plaintext);
  // 首次替换前核对当前用户确实能够解开新凭据和恢复材料。
  const verified=await crypt('unprotect',encrypted);
  if(verified.some((value,index)=>!value.equals(plaintext[index])))throw failure();
  const directory=join(resolve(dataRoot),'.credentials');
  if(encrypted.length)await mkdir(directory,{recursive:true});
  for(let index=0;index<keys.length;index++){
    const id=randomBytes(16).toString('hex');
    await writeFile(join(directory,id+'.json'),JSON.stringify({version:1,kind:'secret',ciphertext:encrypted[index].toString('base64')})+'\n',{flag:'wx',mode:0o600});
    changes[keys[index]]=prefix+id;
  }
  if(backup)await writeFile(join(directory,'legacy-env-'+Date.now()+'-'+randomBytes(8).toString('hex')+'.json'),JSON.stringify({version:1,kind:'env-backup',ciphertext:encrypted.at(-1).toString('base64')})+'\n',{flag:'wx',mode:0o600});
  // 保留未知字段、注释和原始顺序，仅替换实际凭据字段。
  return replaceEnvAssignments(text,Object.fromEntries(Object.entries(changes).map(([key,value])=>[key,key+"='"+value+"'"])));
}
