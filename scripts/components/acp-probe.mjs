import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

/** 只建立协议连接，不创建会话、不发送提示词，不读取用户登录目录。 */
export async function verifyAcp({node,entry,cwd,env,signal,timeoutMs=30000}) {
  const acp=await import('@agentclientprotocol/sdk');
  const child=spawn(node,[entry,'--profile','acp'],{cwd,env,signal,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let done,fail,settled=false,stopping=false;
  const ready=new Promise((yes,no)=>{done=yes;fail=no;});
  const reject=error=>{if(!settled){settled=true;fail(error);}};
  child.stderr.resume();
  const closed=new Promise(resolve=>child.once('close',resolve));
  child.on('error',reject);
  child.once('close',()=>reject(new Error('DSH 在 ACP 初始化前退出，请重新准备组件')));
  const timer=setTimeout(()=>reject(new Error('DSH ACP 初始化超时，请检查组件与运行环境')),timeoutMs);
  const stream=acp.ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout));
  const task=acp.client({name:'component-check'}).connectWith(stream,async context=>{
    const init=await context.request(acp.methods.agent.initialize,{protocolVersion:acp.PROTOCOL_VERSION,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}}});
    if(init.protocolVersion!==acp.PROTOCOL_VERSION)throw new Error('DSH ACP 协议版本不匹配');
    if(!settled){settled=true;done();}
    await closed;
  });
  task.catch(error=>{if(!stopping)reject(error);});
  try {await ready;}
  finally {clearTimeout(timer);stopping=true;child.kill();await closed;await task.catch(()=>{});}
}
