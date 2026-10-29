import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// 使用实际组件的工具注册器验证执行边界，不访问 QQ、网络或模型。
const [directory,root]=process.argv.slice(2);
if(!directory||!root)throw new Error('缺少工具策略验证路径');
const require=createRequire(join(resolve(directory),'package.json'));
const {Context}=require('@deepseek-ai/cordis');
const {ToolRuntime,defineContentToolFixture}=require('@deepseek-ai/dsh-tools');
const {SystemPrompt}=require('@deepseek-ai/dsh-system-prompt');
const {HttpFetchProvider}=require('@deepseek-ai/dsh-web-fetch-http');
const policy=await import(pathToFileURL(join(resolve(root),'dist/security/dsh-policy.js')).href);
const ctx=new Context();
await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(policy);
let dispatched=0;
try {
  ctx.on('tools/pre-execute',()=>({kind:'allow'}));
  const names=['read_file','exec_command','spawn_agent','mcp__other__read','mcp__qq__qq_reply'];
  for(const name of names)ctx.tools.register(defineContentToolFixture({name,description:'isolated policy probe',parameters:{},execute:async()=>{dispatched++;return [{type:'text',text:'fixture-body'}];}}));
  for(const name of names) {
    const result=await ctx.tools.execute({name,arguments:{},callId:'probe-'+name,signal:new AbortController().signal});
    assert.equal(result.isError,name!=='mcp__qq__qq_reply',name+': '+JSON.stringify(result));
  }
  assert.equal(dispatched,1,'被拒绝的工具不能进入实际执行体');
  const provider=new HttpFetchProvider({timeoutMs:1000,maxRedirects:0,maxResponseBytes:1024});
  for(const url of ['http://127.0.0.1/','http://10.1.2.3/','http://169.254.169.254/'])await assert.rejects(provider.fetch({url},new AbortController().signal),/non-public IP/);
  console.log('Native tool dispatch guard passed without model, QQ or network calls.');
}finally{await ctx.fiber.dispose();}
