import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareRuntime} from './app-paths.mjs';
import {initializeWebOwner} from '../server/auth.mjs';
import {createManagementServer} from '../server/app.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
try {
  const [action='start',...args]=process.argv.slice(2);let port=18380,origin;
  for(let i=0;i<args.length;i++)if(args[i]==='--port'||args[i]==='--origin'){
    const option=args[i],value=args[i+1];if(!value)throw new Error(option+' 需要参数');if(option==='--port'){if(!/^\d{1,5}$/.test(value))throw new Error('端口无效');port=Number(value);}else origin=value;args.splice(i,2);i--;
  }
  const layout=await prepareRuntime({root,args});
  if(action==='init'||action==='reset-auth') {
    const result=await initializeWebOwner(layout.dataRoot,{reset:action==='reset-auth'});
    console.log('请通过本机或 SSH 隧道打开控制台，使用以下一次性认领码设置管理口令。认领码 15 分钟有效，请勿分享。');
    console.log(result.token);
  } else if(action==='start') {
    const server=await createManagementServer({root,dataRoot:layout.dataRoot,port,origin});
    console.log('小鲸私有控制台：'+server.origin+'（通过本机或 SSH 隧道访问）');
    let closing=false;const stop=async()=>{if(closing)return;closing=true;try{await server.close();}finally{process.exit();}};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  } else throw new Error('服务命令为 start、init 或 reset-auth');
}catch(error){console.error(error.code==='ENOENT'?'尚未初始化管理凭据，请先运行 npm run server:init -- --data-dir 数据目录。':error.message);process.exitCode=1;}
