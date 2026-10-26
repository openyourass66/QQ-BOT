import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Autonomy } from '../dist/agent/autonomy.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';
import { DailyUsageStore } from '../dist/core/usage.js';
import { SocialStore } from '../dist/qq/social-store.js';
import { SocialEngine } from '../dist/qq/social-engine.js';
import { MediaService } from '../dist/services/media.js';
import { QzoneService } from '../dist/services/qzone.js';

const minute=60000,hour=60*minute;
async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qq-autonomy-triggers-')),clock={now:Date.now()},settings=structuredClone(DEFAULT_SETTINGS),calls=[];
  Object.assign(settings.social,{proactiveEnabled:true,quietStartHour:0,quietEndHour:0,autoQzoneEnabled:false,autoCollectStickers:false,proactiveIntervalMinutes:120});
  const store=new SocialStore(join(root,'social.json'));await store.load();await store.account(10000);
  const usage=new DailyUsageStore(join(root,'usage.json'),()=>new Date(clock.now));await usage.load();
  const api={async call(action,args){calls.push({action,args});if(action==='get_login_info')return {user_id:10000};if(action==='get_cookies')return {cookies:'uin=o10000; p_skey=fixture-key'};if(action==='get_friend_list')return [{user_id:20001,nickname:'朋友甲'},{user_id:20002,nickname:'朋友乙'}];if(action==='get_group_list')return [];return {message_id:1000+calls.length};}};
  let posts=true,postRequests=0;
  const qzone=new QzoneService(api,{fetch:async(url,options)=>{if(options.method==='POST'){postRequests++;return new Response('{"code":0,"commentid":"fixture-comment"}');}return new Response(JSON.stringify({code:0,total:posts?1:0,msglist:posts?[{tid:'real-post',uin:Number(url.searchParams.get('uin')),content:'公开的新动态',created_time:Math.floor(Date.now()/1000)}]:[]}));}});
  const media=new MediaService(join(root,'media'),()=>settings.social),engine=new SocialEngine(store,media,api,usage,()=>settings,async()=>true,()=>{},()=>{},qzone);
  const autonomy=new Autonomy(store,()=>settings,usage,()=>clock.now,media);engine.autonomy=autonomy;
  const ctx=a=>({chat:'private:20001',self:10000,user:20001,sent:0,silent:false,signal:new AbortController().signal,proactive:true,...(a?{autonomous:a}:{})});
  const add=async()=>{await store.add({chat:'private:20001',id:1,user:20001,name:'朋友',at:clock.now-3*hour,text:'之前聊过猫猫',segments:[],self:false,recalled:false});};
  try{await run({root,clock,settings,store,usage,api,engine,autonomy,media,calls,ctx,add,setPosts:value=>{posts=value;},postCount:()=>postRequests});}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('到期想法不再等待两小时扫描；队列忙时不消耗模型判断额度',()=>fixture(async({clock,autonomy,store,usage,ctx})=>{
  await store.add({chat:'private:20001',id:1,user:20001,name:'朋友',at:clock.now,text:'刚聊完的事',segments:[],self:false,recalled:false});
  await store.update(d=>{d.autonomous.lastScanAt=clock.now;d.autonomous.thoughts.push({id:'due',key:'due',chat:'private:20001',kind:'chat',messageId:1,summary:'到期的想法',reason:'已经约好的事',at:clock.now,due:clock.now+minute,expires:clock.now+hour,priority:80,state:'pending',result:''});});
  clock.now+=minute;let wakes=0;
  await autonomy.tick(ctx().signal,async()=>wakes++,()=>false);assert.equal(wakes,0);assert.equal(usage.used('autonomous-decisions'),0);
  await autonomy.tick(ctx().signal,async()=>wakes++);assert.equal(wakes,1);assert.equal(usage.used('autonomous-decisions'),1);
}));

test('没有新消息也周期性重新考虑主动聊天，实际发出后无人回应则暂停',()=>fixture(async({clock,autonomy,store,ctx,add})=>{
  await add();let wakes=0;
  await autonomy.tick(ctx().signal,async(t,a)=>{wakes++;a.reason='暂时没有具体话题';});assert.equal(wakes,1);
  clock.now+=61*minute;await autonomy.tick(ctx().signal,async(t,a)=>{wakes++;await autonomy.sent(ctx(a));});assert.equal(wakes,2);
  clock.now+=3*hour;await autonomy.tick(ctx().signal,async()=>wakes++);assert.equal(wakes,2);assert.equal(store.snapshot().autonomous.contacts[0].unanswered,1);
}));

test('模型失败但没有外部动作时，不把好友误标为未回应而永久沉默',()=>fixture(async({clock,autonomy,store,ctx,add})=>{
  await add();await autonomy.tick(ctx().signal,async()=>{throw new Error('Active session disposed');});assert.equal(store.snapshot().autonomous.contacts[0].unanswered,0);
  clock.now+=61*minute;let wakes=0;await autonomy.tick(ctx().signal,async()=>wakes++);assert.equal(wakes,1);
}));

test('图片在三十秒后及时挑选，后台关闭时不堆积过期收藏任务',()=>fixture(async({clock,autonomy,store,settings,ctx})=>{
  settings.social.autoCollectStickers=true;
  const image=id=>({chat:'private:20001',id,user:20001,name:'朋友',at:clock.now,text:'图片',segments:[{type:'image',data:{file:'fixture'}}],self:false,recalled:false});
  await store.add(image(1));await autonomy.observe('private:20001',1);clock.now+=31000;
  let kind;await autonomy.tick(ctx().signal,async t=>{kind=t.kind;});assert.equal(kind,'collect');
  settings.social.proactiveEnabled=false;await store.add(image(2));await autonomy.observe('private:20001',2);assert.equal(store.snapshot().autonomous.thoughts.filter(t=>t.kind==='collect').length,1);
}));

test('主动聊天可自行发语音，并计入主动消息额度',()=>fixture(async({clock,settings,store,engine,media,usage,ctx,add,calls})=>{
  await add();settings.social.speechModel='fixture-tts';const file=await media.save(Buffer.from('voice'),'.mp3');media.speech=async()=>file;
  await store.update(d=>d.autonomous.thoughts.push({id:'voice',key:'voice',chat:'private:20001',kind:'chat',summary:'主动聊一句',reason:'共同兴趣',at:clock.now,due:clock.now,expires:clock.now+hour,priority:80,state:'running',result:''}));
  await engine.execute({action:'social',tool:'qq_speak',args:{text:'刚看到一只很像你表情包里的猫。'}},ctx({kind:'chat',thoughtId:'voice',effects:new Set(),messages:0,reason:''}));
  assert.equal(calls.filter(c=>c.action==='send_private_msg').length,1);assert.equal(usage.used('proactive'),1);
}));

test('自主空间互动无需聊天记录，先读取真实新动态再评论，重启后不重复',()=>fixture(async({root,settings,store,engine,postCount,usage})=>{
  Object.assign(settings.social,{autoQzoneCommentEnabled:true,qzoneCommentIntervalMinutes:5});Object.assign(settings.features.qzone,{browseEnabled:true,commentsEnabled:true,commentRequireConfirm:false});
  let woke=0;
  await engine.tick(10000,new AbortController().signal,async(chat,reason,a)=>{
    woke++;assert.equal(chat,'');assert.equal(a.kind,'qzone-comment');assert.equal(a.targetUser,20001);assert.ok(a.spacePost?.id);
    const context={chat:'private:10000',self:10000,user:10000,sent:0,silent:false,proactive:true,autonomous:a,signal:new AbortController().signal};
    await assert.rejects(engine.execute({action:'social',tool:'qq_recent_messages',args:{}},context),/不允许/);
    await assert.rejects(engine.execute({action:'social',tool:'qq_qzone_feed',args:{user_id:20002}},context),/选定好友/);
    await engine.execute({action:'social',tool:'qq_qzone_comment',args:{post_id:a.spacePost.id,text:'这个画面很有意思'}},context);
  });
  assert.equal(woke,1);assert.equal(postCount(),1);assert.equal(usage.used('qzone-comments'),1);assert.equal(usage.used('proactive'),0);
  const saved=new SocialStore(join(root,'social.json'));await saved.load();assert.equal(saved.snapshot().autonomous.spaceComments[0].state,'success');assert.equal(store.snapshot().autonomous.decisions.at(-1).outcome,'done');
}));

test('好友没有近期新动态时不唤醒模型、不消耗模型判断额度',()=>fixture(async({settings,engine,usage,store,setPosts})=>{
  Object.assign(settings.social,{autoQzoneCommentEnabled:true});Object.assign(settings.features.qzone,{browseEnabled:true,commentsEnabled:true});setPosts(false);
  let wakes=0;await engine.tick(10000,new AbortController().signal,async()=>wakes++);assert.equal(wakes,0);assert.equal(usage.used('autonomous-decisions'),0);assert.match(store.snapshot().autonomous.decisions.at(-1).reason,/不唤醒模型/);
}));

test('空间互动摘要不进入独立空间创作上下文',()=>fixture(async({autonomy,store,ctx})=>{
  await store.update(d=>d.autonomous.decisions.push({id:'comment',thoughtId:'old',chat:'',kind:'qzone-comment',at:Date.now(),outcome:'done',reason:'FRIEND_SPACE_PRIVATE_MATERIAL'}));
  const view=autonomy.view({...ctx(),chat:'private:10000',autonomous:{kind:'qzone',thoughtId:'public',effects:new Set(),messages:0,reason:''}});assert.doesNotMatch(JSON.stringify(view),/FRIEND_SPACE_PRIVATE_MATERIAL/);
}));
