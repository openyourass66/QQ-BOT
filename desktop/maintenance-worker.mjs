import {createBackup,verifyBackup,restoreBackup,recoverMaintenance,maintenanceStatus} from '../scripts/maintenance.mjs';

const cancellation=new AbortController();let started=false;
let lastProgress=0,lastStage='';
process.on('message',async request=>{
  if(request?.action==='cancel'){cancellation.abort(new Error('维护已取消，正在保留或撤回本次未完成操作。'));return;}
  if(started)return;started=true;
  try{
    const data=request?.data,operation=data?.operation;
    if(!data||!['status','backup','verify','restore','recover'].includes(operation)||Object.keys(data).some(key=>!['operation','file','password'].includes(key)))throw new Error('维护操作格式无效。');
    if(!['status','recover'].includes(operation)&&(typeof data.file!=='string'||!data.file||data.file.length>4096))throw new Error('请选择有效的备份文件。');
    const options={dataRoot:process.cwd(),file:data.file,password:data.password,signal:cancellation.signal,onProgress:progress=>{const now=Date.now();if(progress.stage!==lastStage||now-lastProgress>=200||progress.stage==='complete'){lastProgress=now;lastStage=progress.stage;process.send?.({type:'maintenance-progress',...progress});}}};
    const result=operation==='status'?await maintenanceStatus(process.cwd()):await ({backup:createBackup,verify:verifyBackup,restore:restoreBackup,recover:recoverMaintenance}[operation])(options);
    process.send?.({ok:true,result},()=>process.disconnect());
  }catch(error){process.send?.({ok:false,error:cancellation.signal.aborted?'维护已取消；恢复切换中的操作已尝试撤回，若提示中断请先处理再启动。':error.code?.includes('SQLITE')?'数据库检查未通过，当前数据已保留。':['EACCES','EPERM'].includes(error.code)?'无法访问所选文件或目录，请检查权限；当前数据及恢复点已保留。':error.code==='ENOENT'?'所选文件或数据路径不存在，请检查位置；当前数据已保留。':error.message,code:error.code},()=>process.disconnect());}
});
