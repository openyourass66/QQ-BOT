import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installRelease,rollbackInstallation,recoverInstallation,uninstallInstallation,installedState} from './installer-core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),controller=new AbortController();let busy=false,buffer='';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
  buffer+=chunk;if(buffer.length>65536){send({type:'result',ok:false,error:'安装请求过大。'});process.exitCode=1;process.stdin.destroy();return;}
  let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);void receive(line);}
});
process.stdin.once('end',()=>controller.abort(new Error('安装控制窗口已断开，正在保留或撤回操作。')));
async function receive(line){
  let request;try{request=JSON.parse(line);}catch{send({type:'result',ok:false,error:'安装请求格式无效。'});return;}
  if(request?.operation==='cancel'){controller.abort(new Error('安装已取消，旧版或恢复记录已保留。'));return;}if(busy)return;busy=true;
  try{
    if(!request||!['install','repair','rollback','recover','uninstall','status'].includes(request.operation)||Object.keys(request).some(key=>!['operation','packageRoot','installRoot','dataRoot','password'].includes(key)))throw Error('安装操作格式无效。');
    for(const key of ['installRoot','dataRoot'])if(typeof request[key]!=='string'||!request[key]||request[key].length>4096)throw Error('请选择有效的程序和数据目录。');
    if(['install','repair'].includes(request.operation)&&(typeof request.packageRoot!=='string'||!request.packageRoot||request.packageRoot.length>4096))throw Error('请选择已经解压的完整发行包目录。');
    let progressAt=0,stage='';const options={...request,root,repair:request.operation==='repair',signal:controller.signal,onProgress:progress=>{const now=Date.now();if(stage!==progress.stage||now-progressAt>=200){stage=progress.stage;progressAt=now;send({type:'progress',...progress});}}};
    const result=request.operation==='status'?{operation:'status',state:await installedState(request.installRoot)}:await ({install:installRelease,repair:installRelease,rollback:rollbackInstallation,recover:recoverInstallation,uninstall:uninstallInstallation}[request.operation])(options);
    send({type:'result',ok:true,result});
  }catch(error){send({type:'result',ok:false,code:error.code,error:controller.signal.aborted?'安装已取消；若存在中断记录，请先处理上次中断。':error.code?.includes('SQLITE')?'安装资源或数据库检查未通过，请先退出使用同一数据的工作台。':['EACCES','EPERM'].includes(error.code)?'无法写入所选目录，请检查当前用户权限；旧版和数据已保留。':error.message});}
  finally{process.stdin.destroy();}
}
