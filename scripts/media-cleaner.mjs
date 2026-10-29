import {spawn} from 'node:child_process';
import {readFile,mkdir,stat,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';

const failure=()=>Object.assign(new Error('媒体清理组件结果未确认，已停止后续删除；请重新核对媒体库'),{code:'MEDIA_CLEANUP_UNCONFIRMED'});
function environment(){const env={};for(const name of ['SystemRoot','WINDIR','SystemDrive','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];env.PATH=join(process.env.WINDIR||'C:\\Windows','System32');return env;}
const running=child=>child.exitCode===null&&child.signalCode===null;

export async function mediaCleanerExecutable({root,dataRoot,signal}){
  if(process.platform!=='win32')throw new Error('实际媒体删除目前仅支持 Windows 本地版，可使用 --dry-run 核对候选');
  signal?.throwIfAborted();const source=join(root,'desktop/MediaCleanup.cs');
  let bytes;try{bytes=await readFile(source);}catch(error){if(error.code!=='ENOENT')throw error;const bundled=join(root,'desktop/media-cleaner.exe');if(!(await stat(bundled)).isFile())throw new Error('程序缺少媒体维护组件，请修复完整发行包');return bundled;}
  const directory=join(dataRoot,'data/media-cleaner'),target=join(directory,'cleaner-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'.exe');
  if(await stat(target).then(info=>info.isFile(),()=>false))return target;
  await mkdir(directory,{recursive:true});const temporary=target+'.'+randomUUID()+'.exe',framework=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319');
  const child=spawn(join(framework,'csc.exe'),['/nologo','/codepage:65001','/target:exe','/platform:x64','/optimize+','/out:'+temporary,'/reference:'+join(framework,'System.Web.Extensions.dll'),source],{windowsHide:true,env:environment(),stdio:'ignore'});
  const done=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',code=>resolve({code}));});
  const abort=()=>child.kill(),timer=setTimeout(abort,15000);signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  try{const result=await done;signal?.throwIfAborted();if(result.error||result.code!==0)throw new Error('媒体维护组件编译失败，请检查 .NET Framework 4.8 或修复程序');await rename(temporary,target).catch(async error=>{if(!await stat(target).then(info=>info.isFile(),()=>false))throw error;});return target;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await rm(temporary,{force:true});}
}

/** Each file is held exclusively through hashing and explicit authorization; no path-based unlink. */
export function mediaRemover(executable){return async(root,entry,cutoff,authorize,signal)=>{
  signal.throwIfAborted();
  const child=spawn(executable,[String(process.pid)],{windowsHide:true,env:environment(),stdio:['pipe','pipe','ignore']});
  const done=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,exitSignal)=>resolve({code,exitSignal}));});
  child.stdin.on('error',()=>{});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity}),iterator=lines[Symbol.asyncIterator]();let timedOut=false,interrupt;
  const interrupted=new Promise(resolve=>interrupt=resolve),withAbort=promise=>Promise.race([promise,interrupted.then(()=>{signal.throwIfAborted();throw failure();})]);
  const abort=()=>{child.kill();interrupt();},timer=setTimeout(()=>{timedOut=true;abort();},15000);signal.addEventListener('abort',abort,{once:true});
  const next=async()=>{const line=await withAbort(iterator.next());if(line.done||Buffer.byteLength(line.value)>4096)throw failure();let message;try{message=JSON.parse(line.value);}catch{throw failure();}return message;};
  try{
    if(signal.aborted)abort();const request=JSON.stringify({root,name:entry.name,size:entry.size,cutoff});if(Buffer.byteLength(request)>131072)throw failure();child.stdin.write(request+'\n');
    let result=await next();
    if(result.status==='ready'){
      const permitted=await withAbort(authorize());signal.throwIfAborted();child.stdin.end(permitted?'delete\n':'keep\n');result=await next();
    }else child.stdin.end();
    const completion=await done;signal.throwIfAborted();
    if(timedOut||completion.error||completion.code!==0||!['deleted','missing','kept'].includes(result.status))throw failure();
    return {status:result.status,...(typeof result.reason==='string'?{reason:result.reason.slice(0,64)}:{})};
  }catch(error){signal.throwIfAborted();throw error;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);if(running(child))child.kill();child.stdin.destroy();await done;lines.close();}
};}
