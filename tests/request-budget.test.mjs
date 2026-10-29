import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {validateSettings} from '../dist/core/settings.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {RequestBudget} from '../dist/agent/request-budget.js';
import {startModelBudgetServer} from '../dist/services/model-budget-server.js';
import {MediaService} from '../dist/services/media.js';
import {learningModel} from '../dist/agent/learning-model.js';
import {Cognition,cognitionRevision} from '../dist/agent/cognition.js';
import {SocialStore} from '../dist/qq/social-store.js';
import {reportedServiceUsage} from '../dist/agent/service-request.js';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-request-budget-')),usage=new SqliteDailyUsageStore(join(root,'usage.json'));try{await usage.load();await run({root,usage,settings:validateSettings({})});}finally{await usage.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
const request=(sessionId='session',extra={})=>({sessionId,id:randomUUID(),kind:'conversation',provider:'fixture',model:'test',bytes:100,maxOutputTokens:1024,...extra});
const scope=(extra={})=>({chat:'private:2',user:'2',background:false,signal:new AbortController().signal,allowed:()=>true,...extra});
const known={inputTokens:12,outputTokens:5};

test('每次外部模型请求都预扣总额和用户额度，服务上报与未知用量分别记录且不可覆盖',()=>fixture(async({usage,settings})=>{
  settings.requests.perDay=2;const budget=new RequestBudget(usage,()=>settings),end=budget.bind('session',scope());
  try{
    const original=request(),first=await budget.reserve(original);assert.equal(usage.used('service-requests'),1);assert.equal(usage.used('service-user:2'),1);assert.equal(budget.active,1);
    await budget.finish(first.id,'completed',known);await budget.finish(first.id,'completed',known);await assert.rejects(budget.finish(first.id,'completed',{inputTokens:99,outputTokens:99}),/覆盖/);
    budget.completed.clear();await assert.rejects(budget.reserve(original),/不会再次提交/);
    const second=await budget.reserve(request());await budget.finish(second.id,'completed',{inputTokens:null,outputTokens:null});await assert.rejects(budget.reserve(request()),/额度已用完/);
    const stats=await usage.requestStatistics();assert.equal(stats.requests,2);assert.equal(stats.usageKnown,1);assert.equal(stats.usageUnknown,1);assert.equal(stats.knownInputTokens,12);assert.equal(stats.knownOutputTokens,5);assert.equal(budget.active,0);
  }finally{end();budget.close();}
}));

test('先占用并发槽位再等待持久化，速率、每轮、材料和输出上限均在提交外部请求前拒绝',()=>fixture(async({usage,settings})=>{
  let now=0;settings.requests.concurrent=1;settings.requests.perMinute=2;settings.requests.perTurn=2;const budget=new RequestBudget(usage,()=>settings,{now:()=>now}),end=budget.bind('session',scope());
  try{
    const pending=budget.reserve(request());await assert.rejects(budget.reserve(request()),/并发已满/);const first=await pending;await budget.finish(first.id,'completed',known);
    await assert.rejects(budget.reserve(request('session',{bytes:settings.requests.maxRequestKiB*1024+1})),/材料超过/);await assert.rejects(budget.reserve(request('session',{maxOutputTokens:settings.requests.maxOutputTokens+1})),/输出上限/);
    const second=await budget.reserve(request());await budget.finish(second.id,'completed',known);await assert.rejects(budget.reserve(request()),/本轮模型请求预算/);
    const other=budget.bind('other',scope({chat:'group:3'}));try{await assert.rejects(budget.reserve(request('other')),/过于频繁/);now=60001;const accepted=await budget.reserve(request('other'));await budget.finish(accepted.id,'completed',known);}finally{other();}
  }finally{end();budget.close();}
}));

test('背景、媒体及学习额度共用事务，专用额度拒绝不会消耗总额；排队期间能力关闭不放行',()=>fixture(async({usage,settings})=>{
  settings.requests.mediaPerDay=0;let allowed=true;const budget=new RequestBudget(usage,()=>settings),end=budget.bind('session',scope({background:true,allowed:()=>allowed}));
  try{
    await assert.rejects(budget.reserve(request('session',{kind:'vision'})),/额度已用完/);assert.equal(usage.used('service-requests'),0);
    const learned=await budget.reserve(request('session',{kind:'learning'}));assert.equal(usage.used('learning'),1);assert.equal(usage.used('service-background'),1);assert.equal(usage.used('service-user:2'),0);await budget.finish(learned.id,'completed',known);
    allowed=false;await assert.rejects(budget.reserve(request()),/已关闭/);assert.equal(usage.used('service-requests'),1);
  }finally{end();budget.close();}
}));

test('预扣后取消保留未知记录，未进入外部服务；私有接口拒绝伪造身份、未授权和超大请求',()=>fixture(async({usage,settings})=>{
  const controller=new AbortController(),wrapped={reserveModel:async(...args)=>{const result=await usage.reserveModel(...args);controller.abort();return result;},finishModel:(...args)=>usage.finishModel(...args)};
  const cancelled=new RequestBudget(wrapped,()=>settings),unbind=cancelled.bind('cancelled',scope({signal:controller.signal}));try{await assert.rejects(cancelled.reserve(request('cancelled')),/已结束或被取消/);assert.equal(cancelled.active,0);assert.equal((await usage.requestStatistics()).unknownResults,1);}finally{unbind();cancelled.close();}
  const budget=new RequestBudget(usage,()=>settings),end=budget.bind('session',scope()),server=await startModelBudgetServer(budget);
  try{
    const post=(body,headers={})=>fetch(server.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+server.token,...headers},body:typeof body==='string'?body:JSON.stringify(body)});
    assert.equal((await post({op:'limits',sessionId:'session'},{authorization:'Bearer wrong'})).status,401);assert.equal((await post({op:'limits',sessionId:'session'},{origin:'https://evil.test'})).status,401);
    assert.equal((await post({op:'reserve',...request(),role:'owner',user:'another'})).status,400);assert.equal((await post('x'.repeat(8193))).status,413);
    const accepted=await post({op:'reserve',...request()});assert.equal(accepted.status,200);const {data}=await accepted.json();assert.equal((await post({op:'finish',id:data.id,outcome:'completed',usage:known})).status,200);
  }finally{end();await server.close();}
}));

test('独立媒体先预扣再调用，随对话传图不重复计次，已上报与未知用量不混用',()=>fixture(async({root,usage,settings})=>{
  const originalFetch=globalThis.fetch,oldBase=process.env.BOT_MEDIA_BASE_URL;process.env.BOT_MEDIA_BASE_URL='https://media.fixture/v1/';
  const budget=new RequestBudget(usage,()=>settings),media=new MediaService(join(root,'media'),()=>settings.social,input=>budget.prepareService(input,scope()));let calls=0;
  globalThis.fetch=async(_url,init)=>{calls++;assert.equal(usage.used('service-requests'),calls);const payload=JSON.parse(init.body);assert.equal(payload.max_tokens,128);return Response.json({choices:[{message:{content:'看到了图片'}}],usage:{prompt_tokens:7,completion_tokens:3}});};
  const signal=new AbortController().signal,images=[{data:'YWJj',mimeType:'image/png'}];
  try{
    await media.vision(images,'描述',signal);assert.equal(calls,0);assert.equal(usage.used('service-requests'),0);
    settings.social.visionModel='vision';settings.requests.maxOutputTokens=128;settings.requests.mediaPerDay=1;
    assert.deepEqual(await media.vision(images,'描述',signal),{text:'看到了图片'});await assert.rejects(media.vision(images,'描述',signal),/额度已用完/);assert.equal(calls,1);
    settings.requests.mediaPerDay=2;globalThis.fetch=async()=>{calls++;return new Response(Buffer.from([1,2,3]),{headers:{'content-type':'audio/mpeg'}});};settings.social.speechModel='speech';
    await media.speech('你好',signal);assert.equal(calls,2);const stats=await usage.requestStatistics();assert.equal(stats.usageKnown,1);assert.equal(stats.usageUnknown,1);assert.equal(stats.knownInputTokens,7);assert.equal(stats.knownOutputTokens,3);
    assert.deepEqual(reportedServiceUsage({prompt_tokens:'99',completion_tokens:-1,total_tokens:4}),{inputTokens:null,outputTokens:null,totalTokens:4});
  }finally{budget.close();globalThis.fetch=originalFetch;if(oldBase===undefined)delete process.env.BOT_MEDIA_BASE_URL;else process.env.BOT_MEDIA_BASE_URL=oldBase;}
}));

test('媒体与模型续答共用轮次上限，预扣后关闭能力或取消时不进入服务且保留未知记录',()=>fixture(async({usage,settings})=>{
  settings.requests.perTurn=2;const budget=new RequestBudget(usage,()=>settings),trusted=scope({sessionId:'session'}),end=budget.bind('session',trusted);let entered=0,allowed=true;
  const input={kind:'vision',model:'vision',bytes:100,signal:trusted.signal};
  try{
    const first=await budget.reserve(request());await budget.finish(first.id,'completed',known);
    const media=await budget.prepareService(input,{...trusted,allowed:()=>allowed});allowed=false;
    await assert.rejects(media.run(async()=>{entered++;}),/已关闭/);await media.close();assert.equal(entered,0);assert.equal(budget.active,0);
    allowed=true;await assert.rejects(budget.reserve(request()),/本轮模型请求预算/);assert.equal(usage.used('service-requests'),2);assert.equal((await usage.requestStatistics()).unknownResults,1);
    const controller=new AbortController(),prepared=await budget.prepareService({...input,signal:controller.signal},scope());controller.abort();await assert.rejects(prepared.run(async()=>{entered++;}));await prepared.close();assert.equal(entered,0);assert.equal(budget.active,0);
  }finally{end();budget.close();}
}));

test('学习预算拒绝不推进游标，成功时总额与学习额度只预扣一次，解析失败仍保留实际用量',()=>fixture(async({root,usage,settings})=>{
  const social=new SocialStore(join(root,'social.json'));await social.load();const chat='group:3',signal=new AbortController().signal;
  settings.learning.memory=true;settings.learning.chats=[chat];settings.social.allowAll=true;settings.requests.perDay=0;settings.requests.maxOutputTokens=128;
  const message={id:1,user:2,name:'用户',chat,at:1,text:'我喜欢咖啡',segments:[{type:'text',data:{text:'我喜欢咖啡'}}],self:false,recalled:false};await social.add(message);
  const budget=new RequestBudget(usage,()=>settings),model=learningModel({BOT_CHAT_MODE:'profile',BOT_LEARNING_API_KEY:'fixture-key',BOT_LEARNING_BASE_URL:'https://learning.fixture',BOT_LEARNING_MODEL:'learn'},input=>budget.prepareService(input,scope({chat,background:true})));
  const cognition=new Cognition(social,()=>settings,usage,model.analyze,model.available,Date.now,model.prepare),batch=()=>({chat,messages:[message],memories:[],revision:cognitionRevision(social.snapshot(),chat)}),originalFetch=globalThis.fetch;let calls=0,valid=true;
  globalThis.fetch=async(_url,init)=>{calls++;assert.equal(JSON.parse(init.body).max_tokens,128);return Response.json({content:[{type:'text',text:valid?'{}':'invalid JSON'}],usage:{input_tokens:8,output_tokens:4}});};
  try{
    await assert.rejects(cognition.run(batch(),signal),/额度已用完/);assert.equal(calls,0);assert.equal(social.snapshot().cognition.scopes[chat],undefined);assert.equal(social.snapshot().cognition.jobs.length,0);
    settings.requests.perDay=3;await cognition.run(batch(),signal);assert.equal(calls,1);assert.equal(usage.used('learning'),1);assert.equal(usage.used('service-requests'),1);assert.equal(social.snapshot().cognition.scopes[chat].cursor,1);
    valid=false;await cognition.run(batch(),signal);assert.equal(calls,2);assert.equal(social.snapshot().cognition.jobs.at(-1).state,'failed');const stats=await usage.requestStatistics();assert.equal(stats.usageKnown,2);assert.equal(stats.knownInputTokens,16);assert.equal(stats.knownOutputTokens,8);assert.equal(stats.unknownResults,1);assert.equal(stats.background,2);assert.equal(stats.foreground,0);assert.equal(stats.kinds.learning,2);
  }finally{budget.close();globalThis.fetch=originalFetch;}
}));

test('重启将已预扣未结算请求保留为未知，不重复扣款或自动提交',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-request-restart-')),path=join(root,'usage.json');let usage=new SqliteDailyUsageStore(path);const settings=validateSettings({});
  try{
    await usage.load();const budget=new RequestBudget(usage,()=>settings),end=budget.bind('session',scope()),original=request();await budget.reserve(original);end();budget.close();await usage.close();
    usage=new SqliteDailyUsageStore(path);await usage.load();assert.equal(usage.used('service-requests'),1);const stats=await usage.requestStatistics();assert.equal(stats.requests,1);assert.equal(stats.unknownResults,1);assert.equal(stats.usageUnknown,1);
    const recovered=new RequestBudget(usage,()=>settings),unbind=recovered.bind('session',scope());try{await assert.rejects(recovered.reserve(original),{code:'DATABASE_RESERVATION_CONFLICT'});assert.equal(usage.used('service-requests'),1);}finally{unbind();recovered.close();}
  }finally{await usage.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
