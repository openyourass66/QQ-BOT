import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {verifyAcp} from './acp-probe.mjs';
import {restrictedToolPatches} from '../../dist/agent/chat-model.js';
import {childEnvironment,runChild} from './manager.mjs';

const [node,directory,root]=process.argv.slice(2).map(value=>resolve(value));
if(!node||!directory||!root)throw new Error('需要 Node、DSH 组件和程序目录');
const base=await realpath(tmpdir()),scratch=await mkdtemp(join(base,'qq-tool-policy-'));
try {
  const patch=join(scratch,'policy.json');await writeFile(patch,JSON.stringify(restrictedToolPatches()));
  await verifyAcp({node,entry:join(directory,'node_modules/@deepseek-ai/dsh/lib/bin.js'),cwd:scratch,env:childEnvironment(node,scratch),patch});
  await runChild(node,[join(root,'scripts/components/tool-policy-probe.mjs'),directory,root],{cwd:scratch,env:childEnvironment(node,scratch),timeout:20000});
  await runChild(node,[join(root,'scripts/components/model-budget-probe.mjs'),directory,root],{cwd:scratch,env:childEnvironment(node,scratch),timeout:20000});
  console.log('受限工具策略和请求预算通过真实 DSH 加载与执行检查，未调用付费模型或 QQ。');
}finally {
  const target=await realpath(scratch),rel=relative(base,target);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('验证临时目录位置异常，已保留');
  await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
