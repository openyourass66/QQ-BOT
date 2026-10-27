import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';

/** 只建立协议连接，不创建会话、不发送提示词，不读取用户登录目录。 */
export async function verifyAcp({node,entry,cwd,env,signal,timeoutMs=30000,patch}) {
  const acp=await import('@agentclientprotocol/sdk');
  const nonce=randomBytes(24).toString('hex');
  const child=spawn(node,[entry,'--profile','acp',...(patch?['--patch',patch]:[])],{cwd,env:{...env,...(patch?{BOT_DSH_POLICY_NONCE:nonce}:{})},signal,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let done,fail,settled=false,stopping=false;
  const ready=new Promise((yes,no)=>{done=yes;fail=no;});
  const reject=error=>{if(!settled){settled=true;fail(error);}};
  let policyActive=!patch,stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16000);if(stderr.includes(`[whale-policy] ${nonce}\n`))policyActive=true;});
  const closed=new Promise(resolve=>child.once('close',resolve));
  child.on('error',reject);
  child.once('close',()=>reject(new Error('DSH 在 ACP 初始化前退出，请重新准备组件')));
  const timer=setTimeout(()=>reject(new Error('DSH ACP 初始化超时，请检查组件与运行环境')),timeoutMs);
  const stream=acp.ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout));
  const task=acp.client({name:'component-check'}).connectWith(stream,async context=>{
    const init=await context.request(acp.methods.agent.initialize,{protocolVersion:acp.PROTOCOL_VERSION,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}}});
    if(init.protocolVersion!==acp.PROTOCOL_VERSION)throw new Error('DSH ACP 协议版本不匹配');
    if(!policyActive)throw new Error('DSH 工具策略未加载，组件不可用于机器人运行');
    if(!settled){settled=true;done();}
    await closed;
  });
  task.catch(error=>{if(!stopping)reject(error);});
  try {await ready;}
  finally {clearTimeout(timer);stopping=true;child.kill();await closed;await task.catch(()=>{});}
}
