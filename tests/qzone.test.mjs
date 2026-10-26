import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QzoneService } from '../dist/services/qzone.js';
import { SocialEngine } from '../dist/qq/social-engine.js';
import { SocialStore } from '../dist/qq/social-store.js';
import { MediaService } from '../dist/services/media.js';
import { DailyUsageStore } from '../dist/core/usage.js';
import { DEFAULT_SETTINGS, validateSettings } from '../dist/core/settings.js';
import { toolAvailable } from '../dist/agent/context-policy.js';

const signal=()=>new AbortController().signal;
function rig() {
  const state={self:10000,cookie:'uin=o10000; p_uin=o10000; p_skey=fixture-space-secret; unrelated=keep-private',now:1000000,blocked:new Set(),requests:[],actions:[],postCode:0,getCode:0,malformed:false,fetchError:false,onFetch:null};
  const api={async call(action,args){state.actions.push({action,args});if(action==='get_login_info')return {user_id:state.self};if(action==='get_cookies')return {cookies:state.cookie};if(action==='get_friend_list')return [{user_id:20001,nickname:'好友'}];if(action==='get_group_list')return [{group_id:30001,group_name:'群'}];throw new Error('unexpected action');}};
  const fetch=async(url,options)=>{
    state.requests.push({url:new URL(url),options});await state.onFetch?.(url,options);
    if(state.fetchError)throw new TypeError('do not expose fixture-space-secret');
    if(state.malformed)return new Response('_preloadCallback({"code":0}); globalThis.qzoneExecuted=true;');
    if(options.method==='POST')return new Response(JSON.stringify({code:state.postCode,commentid:'native-comment',cookies:state.cookie}));
    const owner=Number(url.searchParams.get('uin'));
    return new Response('_preloadCallback('+JSON.stringify({code:state.getCode,message:state.getCode?'空间权限不足':'',total:1,cookies:state.cookie,msglist:[{tid:'real-tid',uin:owner,name:'空间主人',content:'周末去爬山 &amp; 喝茶',created_time:1700000000,pic:[{url1:'https://example.com/image.jpg'}],commentlist:[{tid:42,uin:20002,name:'朋友',content:'风景真好'}]}]})+');');
  };
  const service=new QzoneService(api,{fetch,now:()=>state.now,blocked:user=>state.blocked.has(user)});
  return {state,api,service};
}

test('内置空间使用当前账号凭据、固定 HTTPS 地址和 JSONP，返回动态与评论但不返回 Cookie',async()=>{
  const {state,service}=rig(),result=await service.feed('group:30001',10000,20001,5,10,signal());
  assert.equal(result.posts.length,1);assert.equal(result.posts[0].text,'周末去爬山 & 喝茶');assert.equal(result.posts[0].created_at,1700000000000);
  assert.equal(result.posts[0].comments[0].text,'风景真好');assert.match(result.posts[0].url,/20001\/mood\/real-tid$/);
  const request=state.requests[0];assert.equal(request.url.origin,'https://user.qzone.qq.com');assert.equal(request.url.searchParams.get('pos'),'10');assert.equal(request.url.searchParams.get('num'),'5');assert.match(request.url.searchParams.get('g_tk'),/^\d+$/);
  assert.equal(request.options.redirect,'error');assert.match(request.options.headers.cookie,/p_skey=fixture-space-secret/);assert.doesNotMatch(request.options.headers.cookie,/unrelated/);
  assert.deepEqual(state.actions.map(a=>a.action),['get_login_info','get_cookies']);assert.equal(state.actions[1].args.domain,'user.qzone.qq.com');assert.doesNotMatch(JSON.stringify(result),/fixture-space-secret|p_skey|cookies/);
});

test('空间检查验证真实读取路径；缺失、错号凭据在任何空间请求前拒绝',async()=>{
  const {state,service}=rig();const checked=await service.inspect(signal());assert.equal(checked.account,10000);assert.equal(state.requests.length,1);
  state.requests.length=0;state.cookie='uin=o10000; skey=fixture';await assert.rejects(service.feed('private:1',10000,20001,5,0,signal()),/p_skey/);assert.equal(state.requests.length,0);
  state.cookie='uin=o10001; p_skey=fixture';await assert.rejects(service.feed('private:1',10000,20001,5,0,signal()),/不一致/);
  state.self=10001;await assert.rejects(service.feed('private:1',10000,20001,5,0,signal()),/QQ 已切换/);assert.equal(state.requests.length,0);
});

test('空间错误、网络凭据和可执行回调不会泄露或被当成正常动态',async()=>{
  const {state,service}=rig();state.getCode=-1;await assert.rejects(service.feed('group:1',10000,20001,5,0,signal()),/无权/);
  state.getCode=0;state.malformed=true;await assert.rejects(service.feed('group:1',10000,20001,5,0,signal()),/无法读取/);assert.equal(globalThis.qzoneExecuted,undefined);
  state.malformed=false;state.fetchError=true;await assert.rejects(service.inspect(signal()),error=>/连接失败/.test(error.message)&&!error.message.includes('fixture-space-secret'));
});

test('空间响应有大小上限，拒绝重定向、缺失结果与非 JSON 数据',async()=>{
  const {api}=rig();let cancelled=false;
  const large=new QzoneService(api,{fetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(2_000_001));},cancel(){cancelled=true;}}))});
  await assert.rejects(large.inspect(signal()),/内容过大/);assert.equal(cancelled,true);
  for(const response of [new Response('',{status:302,headers:{location:'https://elsewhere.example/'}}),new Response('{}'),new Response('{"code":0}'),new Response('<html>login</html>')]) {
    const service=new QzoneService(api,{fetch:async()=>response});await assert.rejects(service.inspect(signal()),/HTTP 302|响应格式|有效说说|无法读取/);
  }
});

test('分页遇到空列表停止，不重复返回相同偏移',async()=>{
  const {api}=rig(),service=new QzoneService(api,{fetch:async()=>new Response('{"code":0,"total":99,"msglist":[]}')});
  const result=await service.feed('group:1',10000,20001,10,10,signal());assert.deepEqual(result.posts,[]);assert.equal(result.next_offset,null);
});

test('动态编号限制会话、账号和有效期，回复只能选择已读取且未屏蔽的评论',async()=>{
  const {state,service}=rig(),post=(await service.feed('group:1',10000,20001,5,0,signal())).posts[0];
  for(const [chat,self]of [['group:2',10000],['group:1',10001]])await assert.rejects(service.comment(chat,self,{post_id:post.id,text:'测试'},signal(),async()=>{}),/当前会话/);
  await assert.rejects(service.comment('group:1',10000,{post_id:post.id,text:'测试',reply_id:'guessed'},signal(),async()=>{}),/回复目标/);
  state.blocked.add(20002);await assert.rejects(service.comment('group:1',10000,{post_id:post.id,text:'测试',reply_id:post.comments[0].id},signal(),async()=>{}),/屏蔽/);
  state.blocked.clear();state.now+=31*60000;await assert.rejects(service.comment('group:1',10000,{post_id:post.id,text:'测试'},signal(),async()=>{}),/重新浏览/);assert.equal(state.requests.length,1);
});

test('评论与回复使用真实作者和原始编号，相同请求不重复发送，未知结果不重发',async()=>{
  const {state,service}=rig(),post=(await service.feed('group:1',10000,20001,5,0,signal())).posts[0];let reserved=0;
  const args={post_id:post.id,text:'  好棒  '};assert.equal((await service.comment('group:1',10000,args,signal(),async()=>{reserved++;})).commented,true);
  const sent=state.requests.at(-1);assert.equal(sent.options.body.get('topicId'),'20001_real-tid__1');assert.equal(sent.options.body.get('content'),'好棒');assert.equal(sent.url.origin,'https://user.qzone.qq.com');
  assert.equal((await service.comment('group:1',10000,args,signal(),async()=>{reserved++;})).duplicate,true);assert.equal(reserved,1);assert.equal(state.requests.filter(r=>r.options.method==='POST').length,1);
  await service.comment('group:1',10000,{post_id:post.id,text:'谢谢',reply_id:post.comments[0].id},signal(),async()=>{});const reply=state.requests.at(-1);
  assert.equal(reply.url.origin,'https://h5.qzone.qq.com');assert.equal(reply.options.body.get('commentId'),'42');assert.equal(reply.options.body.get('commentUin'),'20002');
  state.fetchError=true;const unknown={post_id:post.id,text:'结果未知'};await assert.rejects(service.comment('group:1',10000,unknown,signal(),async()=>{}),/结果不明|未能确认/);
  const count=state.requests.length;await assert.rejects(service.comment('group:1',10000,unknown,signal(),async()=>{}),/上次结果不明/);assert.equal(state.requests.length,count);
});

test('并发重复评论只提交一次；发送前取消或读取中屏蔽不会继续执行',async()=>{
  const {state,service}=rig(),post=(await service.feed('group:1',10000,20001,5,0,signal())).posts[0];let release;
  state.onFetch=async(url,options)=>{if(options.method==='POST')await new Promise(done=>{release=done;});};
  const args={post_id:post.id,text:'并发测试'},first=service.comment('group:1',10000,args,signal(),async()=>{});
  await assert.rejects(service.comment('group:1',10000,args,signal(),async()=>{}),/正在发送/);
  while(!release)await new Promise(done=>setTimeout(done,1));release();await first;
  const abort=new AbortController();await assert.rejects(service.comment('group:1',10000,{post_id:post.id,text:'取消测试'},abort.signal,async()=>{abort.abort();}),/abort/i);
  assert.equal(state.requests.filter(r=>r.options.method==='POST').length,1);
  state.onFetch=async()=>{state.blocked.add(20001);};await assert.rejects(service.feed('group:1',10000,20001,5,0,signal()),/屏蔽/);
});

async function engineFixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qq-native-space-')),{state,api,service}=rig(),settings=structuredClone(DEFAULT_SETTINGS),confirmations=[];
  const store=new SocialStore(join(root,'social.json'));await store.load();const usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();
  let confirm=async()=>true;
  const engine=new SocialEngine(store,new MediaService(join(root,'media'),()=>settings.social),api,usage,()=>settings,async(text,signal)=>{confirmations.push(text);return confirm(text,signal);},()=>{},()=>{},service);
  const context={chat:'group:30001',self:10000,user:20001,sent:0,silent:false,signal:signal()},call=(tool,args={},ctx=context)=>engine.execute({action:'social',tool,args},ctx);
  try {await run({state,settings,usage,engine,confirmations,call,setConfirm:value=>{confirm=value;}});}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('旧配置安全补齐空间开关；浏览、评论、发布独立，工具清单按开关过滤',()=>{
  const settings=validateSettings({features:{qzone:{enabled:true}}});assert.equal(settings.features.qzone.browseEnabled,false);assert.equal(settings.features.qzone.commentsEnabled,false);assert.equal(settings.features.qzone.commentRequireConfirm,true);
  assert.equal(toolAvailable('qq_qzone_feed',settings,{}),false);settings.features.qzone.browseEnabled=true;
  assert.equal(toolAvailable('qq_qzone_feed',settings,{}),true);assert.equal(toolAvailable('qq_qzone_comment',settings,{}),false);settings.features.qzone.commentsEnabled=true;assert.equal(toolAvailable('qq_qzone_comment',settings,{}),true);
});

test('空间评论独立额度及实际正文审批，拒绝不扣额度；关闭发布不影响评论',()=>engineFixture(async({state,settings,usage,confirmations,call,setConfirm})=>{
  await assert.rejects(call('qq_qzone_feed'),/空间浏览已关闭/);assert.equal(state.actions.length,0);
  Object.assign(settings.features.qzone,{browseEnabled:true,commentsEnabled:true,commentDailyLimit:1});
  const post=(await call('qq_qzone_feed',{user_id:20001})).posts[0];setConfirm(async()=>false);
  await assert.rejects(call('qq_qzone_comment',{post_id:post.id,text:'注意休息'}),/未获管理员确认/);assert.equal(usage.used('qzone-comments'),0);
  assert.match(confirmations[0],/空间主人.*20001/s);assert.match(confirmations[0],/周末去爬山/);assert.match(confirmations[0],/注意休息/);
  setConfirm(async()=>true);await call('qq_qzone_comment',{post_id:post.id,text:'注意休息'});assert.equal(usage.used('qzone-comments'),1);assert.equal(usage.used('qzone'),0);
  await assert.rejects(call('qq_qzone_comment',{post_id:post.id,text:'另一条评论'}),/空间评论今日额度不足/);assert.equal(state.requests.filter(r=>r.options.method==='POST').length,1);
}));

test('审批期间关闭评论、改变确认要求或联系范围，在发送前重新校验',()=>engineFixture(async({state,settings,usage,call,setConfirm})=>{
  Object.assign(settings.features.qzone,{browseEnabled:true,commentsEnabled:true});const post=(await call('qq_qzone_feed',{user_id:20001})).posts[0];
  setConfirm(async()=>{settings.features.qzone.commentsEnabled=false;return true;});await assert.rejects(call('qq_qzone_comment',{post_id:post.id,text:'已关闭'}),/已关闭/);
  settings.features.qzone.commentsEnabled=true;setConfirm(async()=>{settings.social.blockedUsers=['20001'];return true;});await assert.rejects(call('qq_qzone_comment',{post_id:post.id,text:'已屏蔽'}),/屏蔽/);
  assert.equal(usage.used('qzone-comments'),0);assert.equal(state.requests.filter(r=>r.options.method==='POST').length,0);
}));
