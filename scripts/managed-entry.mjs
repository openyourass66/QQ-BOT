import {pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';

// 等待进程树保护建立后才加载业务入口，避免先产生未受管的后代进程。
process.once('message',async message=>{
  if(message!=='managed-launch'||!isAbsolute(process.argv[2]||''))process.exit(2);
  const entry=process.argv[2];process.argv=[process.argv[0],entry,...process.argv.slice(3)];
  try{
    await import(pathToFileURL(entry).href);
    process.send?.({type:'managed-loaded'},()=>{
      // 没有控制消息的短命令应能自然退出，不能仅被宿主 IPC 保持存活。
      if(process.listenerCount('message')===0&&process.listenerCount('disconnect')===1)process.channel?.unref();
    });
  }
  catch{process.send?.({type:'managed-failure',code:'MODULE_INIT_FAILED'},()=>process.exit(1));}
});
process.on('disconnect',()=>{
  if(process.platform!=='win32'){try{process.kill(-process.pid,'SIGKILL');}catch{}}
  process.exit(0);
});
process.send?.({type:'managed-waiting'});
