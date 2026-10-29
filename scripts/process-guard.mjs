import {fork,spawn} from 'node:child_process';
import {readFile,mkdir,rename,stat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
const running=child=>child?.exitCode===null&&child?.signalCode===null;

async function executable(root,dataRoot) {
  const source=join(root,'desktop/ProcessGuard.cs');
  let code;try{code=await readFile(source);}catch(error){if(error.code!=='ENOENT')throw error;const bundled=join(root,'desktop/runtime-guard.exe');if(!(await stat(bundled)).isFile())throw new Error('程序缺少进程保护组件，请修复完整发行包');return bundled;}
  const directory=join(dataRoot,'data/runtime-guard'),target=join(directory,'guard-'+createHash('sha256').update(code).digest('hex').slice(0,16)+'.exe');
  if(await stat(target).then(info=>info.isFile(),()=>false))return target;
  await mkdir(directory,{recursive:true});const temporary=target+'.'+randomBytes(8).toString('hex')+'.exe';
  const framework=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319');
  try{await new Promise((done,reject)=>{
    const child=spawn(join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/out:'+temporary,'/reference:'+join(framework,'System.Web.Extensions.dll'),source],{windowsHide:true,stdio:'ignore'});
    child.once('error',()=>reject(new Error('进程保护组件不可用，请安装 .NET Framework 4.8 或修复程序')));child.once('exit',code=>code===0?done():reject(new Error('进程保护组件编译失败，请修复程序')));
  });
  await rename(temporary,target).catch(async error=>{if(!await stat(target).then(info=>info.isFile(),()=>false))throw error;});return target;
  }finally{await rm(temporary,{force:true});}
}

export class ProcessGuard {
  constructor({root,dataRoot}){this.root=root;this.dataRoot=dataRoot;this.pending=new Map();this.sequence=0;this.children=new Set();this.closing=false;}
  async ready(){
    if(process.platform!=='win32')return;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const file=await executable(this.root,this.dataRoot);
      const helper=spawn(file,[String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.helper=helper;helper.stderr.resume();
      await new Promise((done,reject)=>{
        let ready=false;const timer=setTimeout(()=>{helper.kill();reject(new Error('进程保护组件启动超时'));},10000);
        const failed=()=>{clearTimeout(timer);const error=new Error('进程保护组件已退出，受管业务已停止');if(!ready)reject(error);for(const request of this.pending.values())request.reject(error);this.pending.clear();if(!this.closing)this.onLost?.(error);};
        helper.stdin.on('error',()=>{});
        helper.once('error',failed);helper.once('exit',failed);
        createInterface({input:helper.stdout}).on('line',line=>{
          let message;try{if(line.length>4096)throw new Error();message=JSON.parse(line);}catch{helper.kill();return;}
          if(message.type==='ready'){ready=true;clearTimeout(timer);done();return;}
          const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);message.ok?request.done():request.reject(new Error('无法建立受管进程树，已拒绝启动业务'));
        });
      });
    })();
    return this.starting;
  }
  request(action,pid){
    return new Promise((done,reject)=>{
      const id=String(++this.sequence),timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('进程保护操作超时'));},5000);
      this.pending.set(id,{done:()=>{clearTimeout(timer);done();},reject:error=>{clearTimeout(timer);reject(error);}});
      this.helper.stdin.write(JSON.stringify({id,action,pid})+'\n',error=>{if(error){const request=this.pending.get(id);this.pending.delete(id);request?.reject(new Error('进程保护组件不可用'));}});
    });
  }
  async fork(entry,options={}){
    if(this.closing)throw new Error('运行管理服务正在关闭');
    await this.ready();if(process.platform==='win32'&&!running(this.helper))throw new Error('进程保护组件不可用，请重新打开工作台');
    const {args=[],...childOptions}=options;
    const child=fork(resolve(this.root,'scripts/managed-entry.mjs'),[resolve(this.root,entry),...args],{...childOptions,execArgv:[],silent:true,windowsHide:true,detached:process.platform!=='win32'});
    this.children.add(child);child.once('exit',()=>{this.children.delete(child);if(process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}});
    try{
      await new Promise((done,reject)=>{
        const buffered=[];let bytes=0;
        const timer=setTimeout(()=>{cleanup();reject(new Error('受管进程初始化超时'));},15000);
        const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('error',failed);child.off('exit',exited);};
        const failed=error=>{cleanup();reject(error);};const exited=()=>failed(new Error('受管进程在初始化时退出'));
        const message=async value=>{
          try{
            if(value?.type==='managed-waiting'){if(process.platform==='win32')await this.request('assign',child.pid);child.send('managed-launch');}
            else if(value?.type==='managed-loaded'){cleanup();done();setImmediate(()=>{for(const message of buffered)child.emit('message',message);});}
            else if(value?.type==='managed-failure')failed(Object.assign(new Error('运行组件初始化失败，请检查配置与安装文件'),{code:value.code}));
            else {bytes+=Buffer.byteLength(JSON.stringify(value));if(buffered.length>=100||bytes>1048576)throw new Error('受管进程启动输出过大');buffered.push(value);}
          }catch(error){failed(error);}
        };
        child.on('message',message);child.once('error',failed);child.once('exit',exited);
      });
      return child;
    }catch(error){await this.terminate(child);throw error;}
  }
  async terminate(child){
    if(!child?.pid)return;
    if(process.platform==='win32'){if(running(this.helper))await this.request('terminate',child.pid).catch(()=>{});if(running(child))child.kill();}
    else {try{process.kill(-child.pid,'SIGKILL');}catch{}if(running(child))child.kill();}
  }
  async close(){
    if(this.closeTask)return this.closeTask;this.closing=true;
    this.closeTask=(async()=>{
      await this.starting?.catch(()=>{});
      for(const child of this.children)await this.terminate(child);
      if(running(this.helper)){
        const exited=new Promise(done=>{const timer=setTimeout(()=>{this.helper.kill();done();},5000);this.helper.once('exit',()=>{clearTimeout(timer);done();});});
        await this.request('quit').catch(()=>{});this.helper.stdin.end();await exited;
      }
    })();return this.closeTask;
  }
}
