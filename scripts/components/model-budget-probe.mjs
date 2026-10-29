import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const [directory,root]=process.argv.slice(2);if(!directory||!root)throw new Error('缺少模型预算验证路径');
const require=createRequire(join(resolve(directory),'package.json')),{Context}=require('@deepseek-ai/cordis'),{ToolRuntime,defineContentToolFixture}=require('@deepseek-ai/dsh-tools'),{SystemPrompt}=require('@deepseek-ai/dsh-system-prompt'),{LlmRuntime,LlmAdapter}=require('@deepseek-ai/dsh-llm');
const load=path=>import(pathToFileURL(join(resolve(root),path)).href);
const {SqliteDailyUsageStore}=await load('dist/storage/sqlite-usage-store.js'),{validateSettings}=await load('dist/core/settings.js'),{RequestBudget}=await load('dist/agent/request-budget.js'),{startModelBudgetServer}=await load('dist/services/model-budget-server.js'),{attachModelRequestPolicy}=await load('dist/security/model-request-policy.js'),{nativeToolDenial}=await load('dist/security/dsh-policy.js');
const temporary=await mkdtemp(join(tmpdir(),'qq-model-budget-probe-')),usage=new SqliteDailyUsageStore(join(temporary,'usage.json'));let server,disposeTurn,ctx;
try{
  await usage.load();const settings=validateSettings({requests:{perDay:1,maxOutputTokens:128,nativeWebPerDay:1},context:{toolsPerTurn:2}}),budget=new RequestBudget(usage,()=>settings);
  disposeTurn=budget.bind('probe-session',{chat:'private:2',user:'2',background:false,signal:new AbortController().signal,allowed:()=>true});server=await startModelBudgetServer(budget);
  ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(LlmRuntime);ctx.tools.guard(nativeToolDenial);attachModelRequestPolicy(ctx,server.url,server.token);
  let dispatched=0,web=0,qq=0,cancelled=0,mode='known';class Adapter extends LlmAdapter{async *stream(options){dispatched++;assert.equal(options.maxTokens,128);if(mode==='oversize')yield {type:'text-delta',index:0,text:'x'.repeat(1001)};if(mode==='known')yield {type:'usage',usage:{inputTokens:12,outputTokens:5}};yield {type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['probe'],new Adapter());
  const agent={id:'probe-session',cancel(){cancelled++;}},signal=new AbortController().signal;
  const config=await ctx.waterfall({},'agent/request',{agent,turn:1,signal},async()=>({provider:'probe',model:'fixture',maxTokens:99999}));assert.equal(config.maxTokens,128);
  const options={...config,sessionId:'probe-session',messages:[],signal};for await(const _ of ctx.llm.stream(options)){}assert.equal(dispatched,1);
  await assert.rejects(async()=>{for await(const _ of ctx.llm.stream(options)){}},/额度已用完/);assert.equal(dispatched,1,'预算拒绝时不能进入真实适配器');
  settings.requests.perDay=10;ctx.tools.register(defineContentToolFixture({name:'web_search',description:'isolated fixture',parameters:{},execute:async()=>{web++;return [{type:'text',text:'fixture'}];}}));
  const first=await ctx.tools.execute({name:'web_search',arguments:{},callId:'one',signal,agent});assert.equal(first.isError,false,JSON.stringify(first));assert.equal(web,1);
  const second=await ctx.tools.execute({name:'web_search',arguments:{},callId:'two',signal,agent});assert.equal(second.isError,true);assert.match(JSON.stringify(second),/额度已用完/);assert.equal(web,1);
  const third=await ctx.tools.execute({name:'web_search',arguments:{},callId:'three',signal,agent});assert.equal(third.isError,true);assert.match(JSON.stringify(third),/工具预算已用完/);assert.equal(web,1);
  settings.requests.nativeWebPerDay=10;await ctx.waterfall({},'agent/request',{agent,turn:2,signal},async()=>config);
  ctx.tools.register(defineContentToolFixture({name:'mcp__qq__qq_reply',description:'isolated fixture',parameters:{},execute:async()=>{qq++;return [{type:'text',text:'fixture'}];}}));
  assert.equal((await ctx.tools.execute({name:'mcp__qq__qq_reply',arguments:{},callId:'qq-one',signal,agent})).isError,false);
  assert.equal((await ctx.tools.execute({name:'web_search',arguments:{},callId:'web-one',signal,agent})).isError,false);
  assert.equal((await ctx.tools.execute({name:'mcp__qq__qq_reply',arguments:{},callId:'qq-two',signal,agent})).isError,true);assert.equal(qq,1);assert.equal(web,2);
  mode='unknown';for await(const _ of ctx.llm.stream({...options,purpose:'compaction'})){}assert.equal(dispatched,2);
  mode='oversize';settings.requests.maxResponseChars=1000;await assert.rejects(async()=>{for await(const _ of ctx.llm.stream(options)){}},/输出超过/);assert.equal(cancelled,1);assert.equal(budget.active,0);
  const stats=await usage.requestStatistics();assert.equal(stats.requests,5);assert.equal(stats.usageKnown,1);assert.equal(stats.usageUnknown,4);assert.equal(stats.unknownResults,1);assert.equal(stats.knownInputTokens,12);
  console.log('Actual model registry: provider cap, pre-dispatch quota, web quota, shared tools and reported/unknown usage passed; no paid model, QQ or external network.');
}finally{disposeTurn?.();await server?.close();await ctx?.fiber.dispose();await usage.close();await rm(temporary,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
