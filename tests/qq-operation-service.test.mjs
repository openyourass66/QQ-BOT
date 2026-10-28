import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {QqOperationService} from '../dist/app/qq-operation-service.js';
import {OneBotHttp} from '../dist/qq/onebot.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {operationDigest} from '../dist/core/operation-context.js';
import {classifyRuntimeFailure} from '../dist/core/runtime-failure.js';
import {protocolMutation,assertProtocolOperation,registeredProtocolTools} from '../dist/security/protocol-policy.js';
import {QzoneService} from '../dist/services/qzone.js';

const signal=()=>new AbortController().signal;
const context=(extra={})=>({self:10000,user:20001,chat:'private:20001',origin:'message',messageId:1,sourceTime:100,sent:0,silent:false,signal:signal(),...extra});
async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'qq-effects-')),usage=new SqliteDailyUsageStore(join(root,'usage.json')),store=new SqliteSocialStore(join(root,'social.json'));
  const s=structuredClone(DEFAULT_SETTINGS),calls=[],failures=[],state={account:10000,drop:false,emptyId:false,stopping:false};let next=1,operations;
  const http=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const args=JSON.parse(raw||'{}'),name=req.url.slice(1);if(name==='get_login_info'){res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:state.account}}));return;}calls.push({name,args});if(state.drop){res.destroy();return;}res.end(JSON.stringify({status:'ok',retcode:0,data:name.startsWith('send_')?state.emptyId?{}:{message_id:next++}:{result:0}}));});
  try{
    await usage.load();await store.load();await store.account(10000);http.listen(0,'127.0.0.1');await once(http,'listening');
    const api=new OneBotHttp(`http://127.0.0.1:${http.address().port}`,'',(call,execute)=>operations.intercept(call,execute));
    operations=new QqOperationService(usage,store,{settings:()=>s,account:()=>10000,readAccount:async()=>Number((await api.call('get_login_info')).user_id),stopping:()=>state.stopping,fatal:error=>failures.push(error)});
    const reserve=()=>usage.consume(()=>[{key:'social-actions',amount:1,limit:s.social.actionsPerDay,label:'QQ 动作'}]);
    await run({root,usage,store,s,calls,failures,state,operations,api,reserve});
  }finally{await operations?.close();await Promise.all([usage.close(),store.close()]);http.closeAllConnections();if(http.listening)await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}

test('协议能力逐项登记，未知动作和错误工具不能进入远端',()=>fixture(async({api,operations,calls})=>{
  for(const name of ['get_login_info','get_cookies','get_video'])assert.equal(protocolMutation(name),false);
  for(const name of ['send_private_msg','send_group_msg','add_custom_face','delete_custom_face','send_qzone_msg'])assert.equal(protocolMutation(name),true);
  assert.ok(registeredProtocolTools.includes('qq_set_profile'));
  assert.throws(()=>protocolMutation('unregistered_write'),/未登记/);
  assert.throws(()=>assertProtocolOperation({tool:'qq_reply'},'send_like'),/不能提交/);
  await assert.rejects(api.sendPrivate(20001,'无上下文'),/没有登记/);await assert.rejects(api.call('unregistered_write'),/未登记/);assert.equal(calls.length,0);assert.equal(operations.executor.size,0);
}));

test('真实 OneBot 调用前绑定冻结快照，并发和完成后的相同动作只扣费发送一次',()=>fixture(async({operations,api,reserve,usage,store,calls})=>{
  const ctx=context(),trace=operationDigest('sdk-request'),payload={text:'同一回复'},run=()=>operations.run({...ctx},'qq_reply',payload,'回复',()=>{},async()=>{await reserve();return api.sendPrivate(20001,'同一回复');},trace);
  const results=await Promise.all(Array.from({length:16},run));assert.ok(results.every(row=>row.message_id===1));assert.equal(calls.length,1);assert.equal(usage.used('social-actions'),1);assert.deepEqual(await run(),{message_id:1});
  const alias=operationDigest('reconnected-sdk-request');assert.deepEqual(await operations.run({...ctx},'qq_reply',payload,'回复',()=>{},async()=>{throw new Error('SDK 重连后重复提交');},alias),{message_id:1});assert.equal(usage.used('social-actions'),1);
  await assert.rejects(operations.run({...ctx},'qq_reply',{text:'替换 alias'},'回复',()=>{},async()=>{},alias),/不能更换身份/);
  await assert.rejects(operations.run({...ctx},'qq_reply',{text:'替换'},'回复',()=>{},async()=>{},trace),/不能更换身份/);assert.equal(calls.length,1);
  const actions=store.view('actions').actions;assert.equal(actions.length,1);assert.equal(actions[0].state,'success');assert.equal((await operations.actions(10000,ctx.chat))[0].state,'success');assert.equal((await usage.operationSummaries(20000)).total,0);
  let frozen=false;const guarded=new OneBotHttp('http://127.0.0.1:1','',async(call)=>{frozen=Object.isFrozen(call.params)&&Object.isFrozen(call.params.message)&&Object.isFrozen(call.params.message[0].data);assert.throws(()=>{call.params.message[0].data.text='替换';},TypeError);return {message_id:9};});
  const original={user_id:20001,message:[{type:'text',data:{text:'原文'}}]};assert.deepEqual(await guarded.call('send_private_msg',original),{message_id:9});assert.equal(frozen,true);assert.equal(original.message[0].data.text,'原文');
  await operations.run({...ctx},'qq_send_message',{text:'同一回复',target:'private:20001'},'另一入口',()=>{},async()=>{await reserve();return api.sendPrivate(20001,'同一回复');},operationDigest('other-tool'));
  assert.equal(calls.length,1);assert.equal(usage.used('social-actions'),2);
}));

test('收到发送但丢失响应时保留未知，新工具编号也不能在同轮重发实际相同内容',()=>fixture(async({operations,api,reserve,usage,calls,state})=>{
  const ctx=context(),execute=async()=>{await reserve();return api.sendPrivate(20001,'待核对');};state.drop=true;
  await assert.rejects(operations.run({...ctx},'qq_reply',{text:'待核对'},'回复',()=>{},execute,operationDigest('first')));
  await assert.rejects(operations.run({...ctx},'qq_send_message',{text:'待核对'},'主动发送',()=>{},execute,operationDigest('next')),/相同.*步骤|结果|确认/);
  assert.equal(calls.length,1);assert.equal((await operations.actions(10000,ctx.chat)).filter(row=>row.state==='unknown').length,1);
  state.drop=false;const next=context({messageId:2});assert.equal((await operations.run(next,'qq_reply',{text:'待核对'},'回复',()=>{},execute)).message_id,1);assert.equal(calls.length,2);assert.equal(usage.used('social-actions'),3);
  state.emptyId=true;await assert.rejects(operations.run(context({messageId:3}),'qq_reply',{text:'无编号'},'回复',()=>{},async()=>{await reserve();return api.sendPrivate(20001,'无编号');}),/未返回有效编号/);
}));

test('真实登录账号变化、目标屏蔽和停止都阻止实际提交，账号变化不自动重启',()=>fixture(async({operations,api,reserve,calls,state,s,failures})=>{
  const send=async()=>{await reserve();return api.sendPrivate(20001,'检查账号');};state.account=10001;
  await assert.rejects(operations.run(context(),'qq_reply',{},'回复',()=>{},send),{code:'ACCOUNT_CHANGED'});assert.equal(calls.length,0);assert.equal(failures.length,1);assert.equal(classifyRuntimeFailure(failures[0]).recoverable,false);
  state.account=10000;s.social.blockedUsers.push('20001');await assert.rejects(operations.run(context({messageId:2}),'qq_reply',{},'回复',()=>{},send),/目标已被屏蔽/);assert.equal(calls.length,0);
  state.stopping=true;await assert.rejects(operations.run(context({messageId:3}),'qq_reply',{},'回复',()=>{},send),/正在停止/);assert.equal(calls.length,0);
}));

test('授权和忙碌通知共用总量与专用额度，重复来源不重发，主人通知限于当前主人',()=>fixture(async({operations,api,usage,calls,s})=>{
  s.social.allowAll=false;s.social.allowedUsers=[];s.approval.adminQq=90001;s.requests.noticesPerDay=2;
  const source={account:10000,user:90001,id:1,time:100},send=()=>api.sendPrivate(90001,'授权结果');
  await operations.notice('private:90001','授权结果','approval-help',signal(),send,source);await operations.notice('private:90001','授权结果','approval-help',signal(),send,source);assert.equal(calls.length,1);assert.equal(usage.used('social-actions'),1);assert.equal(usage.used('system-notices'),1);
  await assert.rejects(operations.notice('private:20001','繁忙','busy',signal(),()=>api.sendPrivate(20001,'繁忙'),{...source,id:2,user:20001}),/允许范围/);assert.equal(calls.length,1);
  await operations.notice('private:90001','第二条','approval-help',signal(),()=>api.sendPrivate(90001,'第二条'),{...source,id:2});assert.equal(calls.length,2);
  await assert.rejects(operations.notice('private:90001','超额','approval-help',signal(),()=>api.sendPrivate(90001,'超额'),{...source,id:3}),/额度/);assert.equal(calls.length,2);assert.equal(usage.used('social-actions'),2);
  s.approval.adminQq=90002;await assert.rejects(operations.notice('private:90001','旧主人','approval-help',signal(),send,{...source,id:4}),/主人已变化/);
}));

test('手动 QQ 收藏在所有者上下文登记并扣额度，失败记录和已确认步骤不会丢失',()=>fixture(async({operations,api,usage,calls,state,failures})=>{
  await operations.owner('owner_sticker_collect',{file:'cache.png'},signal(),async()=>{await api.call('add_custom_face',{file:'cache.png'});});
  assert.equal(calls.length,1);assert.equal(usage.used('social-actions'),1);const page=await usage.operationSummaries(10000);assert.equal(page.rows[0].record.origin,'owner');assert.equal(page.rows[0].state,'completed');
  state.account=10001;await assert.rejects(operations.owner('owner_sticker_remove',{id:'old'},signal(),()=>api.call('delete_custom_face',{res_id:'old'})),{code:'ACCOUNT_CHANGED'});assert.equal(calls.length,1);assert.equal(failures.length,1);
}));

test('空间评论按真实动态和评论编号登记，临时阅读编号变化仍阻止同轮重复提交',()=>fixture(async({operations,api,usage,reserve})=>{
  let posts=0;const service=new QzoneService({call:async(name)=>name==='get_login_info'?{user_id:10000}:{cookies:'uin=o10000; p_skey=test-private-cookie;'}},{effect:(payload,invoke)=>operations.effect('qzone_comment',payload,invoke),fetch:async(_,options)=>{if(options.method==='POST'){posts++;throw new Error('lost reply');}return new Response(JSON.stringify({code:0,total:1,msglist:[{tid:'native-tid',uin:20001,content:'动态',commentlist:[{tid:'comment-1',uin:20002,content:'评论'}]}]}));}});
  const ctx=context(),feed=()=>service.feed(ctx.chat,ctx.self,20001,5,0,signal()),first=(await feed()).posts[0];
  const run=(post)=>operations.run({...ctx},'qq_qzone_comment',{post_id:post.id,text:'回复'},'评论',()=>{},()=>service.comment(ctx.chat,ctx.self,{post_id:post.id,reply_id:post.comments[0].id,text:'回复'},signal(),reserve),operationDigest(post.id));
  await assert.rejects(run(first),/不会自动重发/);const second=(await feed()).posts[0];assert.notEqual(first.id,second.id);await assert.rejects(run(second),/确认|相同/);assert.equal(posts,1);assert.equal((await usage.operationSummaries(10000)).rows.filter(row=>row.state==='unknown').length,1);
}));
