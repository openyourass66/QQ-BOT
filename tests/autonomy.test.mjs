import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../dist/social-store.js';
import { SocialEngine } from '../dist/social-engine.js';
import { Autonomy, quietTime } from '../dist/autonomy.js';
import { DailyUsageStore } from '../dist/usage.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { MediaService } from '../dist/media.js';
import { QqActionPolicy } from '../dist/qq-actions.js';
import { socialAdmin } from '../dist/social-admin.js';
import { imageHash } from '../dist/sticker-review.js';
import { fakeQqFavorites, mockStickerAnalysis, completeCollection } from './helpers/sticker-review.mjs';

const minute=60000,hour=3600000;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64');
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'qq-autonomy-'));
  try {
    const clock={now:Date.now()},settings=structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.social,{proactiveEnabled:true,proactiveIntervalMinutes:5,quietStartHour:0,quietEndHour:0,autoQzoneEnabled:false,autoCollectStickers:false});
    settings.chat.group.proactive.enabled=true;settings.chat.group.proactive.perGroupPerDay=20;
    const store=new SocialStore(join(dir,'social.json'));await store.load();await store.account(10000);
    const usage=new DailyUsageStore(join(dir,'usage.json'),()=>new Date(clock.now));await usage.load();
    const media=new MediaService(join(dir,'media'),()=>settings.social),file=await media.save(png,'.png');
    const favorites=fakeQqFavorites(),calls=[],overrides={};let next=100;
    const api={hasLocalMedia:true,call:async(action,args)=>{
      calls.push({action,args});if(overrides[action])return overrides[action](args);
      const favorite=await favorites.protocol(action,args);if(favorite.matched)return favorite.data;
      if(action==='send_qzone_msg')return {tid:'post-'+next++};return {message_id:next++};
    }};
    const engine=new SocialEngine(store,media,api,usage,()=>settings,async()=>true,()=>{},()=>{});
    const autonomy=new Autonomy(store,()=>settings,usage,()=>clock.now,media);engine.autonomy=autonomy;
    const policy=new QqActionPolicy(api,usage,()=>settings,async()=>true);
    const ctx=(extra={})=>({chat:'private:20001',self:10000,user:20001,sent:0,silent:false,signal:new AbortController().signal,...extra});
    const call=(tool,args={},context=ctx())=>engine.execute({action:'social',tool,args},context);
    const add=async(id=1,chat='private:20001',text='聊聊猫猫表情',segments=[{type:'text',data:{text}}])=>{
      await store.add({chat,id,user:20001,name:'测试朋友',at:clock.now,text,segments,self:false,recalled:false});await autonomy.observe(chat,id);
    };
    const remember=(extra={},context=ctx())=>call('qq_thought',{summary:'之后接着聊猫猫',reason:'对方刚聊到喜欢的表情',message_id:1,delay_minutes:1,priority:80,...extra},context);
    const tick=run=>autonomy.tick(ctx().signal,async(t,a)=>run(t,ctx({chat:t.chat||'private:10000',user:t.kind==='qzone'?10000:20001,autonomous:a,proactive:true})));
    const publish=(context,text='关于表情的一点原创感想')=>autonomy.publish(context,text,[],extra=>policy.execute({action:'qzone_post',text},context.signal,()=>[...engine.actionQuotas(context),...extra]));
    await run({dir,clock,settings,store,usage,media,file,favorites,calls,overrides,engine,autonomy,ctx,call,add,remember,tick,publish});
  } finally {await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('旧存档向后兼容；兴趣、未完想法与中断结果跨重启保留',()=>fixture(async({store,add,remember,call,ctx})=>{
  assert.equal(store.snapshot().autonomous.interests.length,0);await add();
  await call('qq_interest',{topic:'猫猫',reason:'对方实际聊到了猫猫',message_id:1});const t=await remember();
  await store.update(d=>{d.autonomous.thoughts.find(x=>x.id===t.id).state='running';d.autonomous.posts.push({hash:'pending',at:1,state:'running',tid:''});});
  const restarted=new SocialStore(store.path);await restarted.load();
  assert.equal(restarted.snapshot().autonomous.interests[0].topic,'猫猫');assert.equal(restarted.snapshot().autonomous.thoughts.find(x=>x.id===t.id).state,'unknown');
  assert.equal(restarted.snapshot().autonomous.posts[0].state,'unknown');
  assert.equal(restarted.snapshot().autonomous.contacts.find(c=>c.chat==='private:20001').unanswered,1);
}));

test('兴趣与想法必须有真实消息依据，按会话隔离，空间任务仅看公开内容',()=>fixture(async({add,call,remember,autonomy,ctx})=>{
  await add();await add(2,'private:20002','另一个会话的秘密');
  await assert.rejects(call('qq_interest',{topic:'秘密',reason:'凭空猜测',message_id:99}),/找不到/);
  await assert.rejects(remember({message_id:2}),/找不到/);
  await call('qq_interest',{topic:'私聊专属兴趣',reason:'私聊内容',message_id:1});await remember();
  const publicContext=ctx({chat:'private:10000',user:10000,autonomous:{kind:'qzone',thoughtId:'x',effects:new Set(),messages:0,reason:''}});
  assert.doesNotMatch(JSON.stringify(autonomy.view(publicContext)),/私聊专属|私聊内容|之后接着聊/);
  assert.equal(autonomy.view(ctx({chat:'private:20002'})).interests.length,0);
  await assert.rejects(remember({kind:'qzone'}),/独立上下文/);
}));

test('想法去重、有效期校验、推迟和放弃均持久化，模型不能自行标记完成',()=>fixture(async({add,remember,call,clock,store})=>{
  await add();const a=await remember(),b=await remember();assert.equal(a.id,b.id);
  await assert.rejects(remember({delay_minutes:120,expires_hours:1}),/过期时间/);
  await call('qq_thought',{op:'defer',thought_id:a.id,reason:'晚点再聊',delay_minutes:30});
  assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===a.id).due,clock.now+30*minute);
  await call('qq_thought',{op:'dismiss',thought_id:a.id,reason:'已经没有继续的必要'});
  assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===a.id).state,'dismissed');
  await assert.rejects(call('qq_thought',{op:'done',thought_id:a.id,reason:'假成功'}));
}));

test('兴趣变化有实际新依据才逐步调整，重复同一条消息不能反复提高偏好',()=>fixture(async({add,call,store})=>{
  await add();await call('qq_interest',{topic:'猫猫',reason:'实际聊天',message_id:1,strength:5});
  assert.equal(store.snapshot().autonomous.interests[0].strength,3);
  await call('qq_interest',{topic:'猫猫',reason:'同一条消息重复',message_id:1,strength:5});assert.equal(store.snapshot().autonomous.interests[0].strength,3);
  await add(2);await call('qq_interest',{topic:'猫猫',reason:'又一次实际聊到',message_id:2,strength:5});assert.equal(store.snapshot().autonomous.interests[0].strength,4);
}));

test('普通消息观察、图片候选去重、过期消息和自己的消息不会阻断正常对话',()=>fixture(async({add,settings,autonomy,store,clock,file})=>{
  settings.social.autoCollectStickers=true;
  await add(1,'private:20001','[图片]',[{type:'image',data:{file}}]);await autonomy.observe('private:20001',1);
  assert.equal(store.snapshot().autonomous.thoughts.filter(t=>t.kind==='collect').length,1);
  await autonomy.observe('private:20001',999); // Expired or retention-trimmed messages are ignored.
  await store.add({chat:'private:20001',id:2,user:10000,name:'自己',at:clock.now,text:'自己',segments:[],self:true,recalled:false});
  await autonomy.observe('private:20001',2);assert.equal(store.snapshot().autonomous.thoughts.length,1);
}));

test('有依据的未来想法到期才唤醒，实际发送才完成；无人回应时暂停后续主动消息',()=>fixture(async({add,remember,tick,clock,store,call,settings})=>{
  await add();const thought=await remember();let wakes=0;
  await tick(async()=>wakes++);assert.equal(wakes,0);clock.now+=6*minute;
  await tick(async(t,context)=>{wakes++;assert.equal(t.id,thought.id);await call('qq_reply',{text:'昨天说的猫猫表情找到了吗'},context);});
  assert.equal(wakes,1);assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===thought.id).state,'done');
  assert.equal(store.snapshot().autonomous.contacts[0].unanswered,1);
  await remember({summary:'另一个后续话题'});clock.now+=2*hour;await tick(async()=>wakes++);assert.equal(wakes,1);
  await add(2);clock.now+=6*minute;await tick(async()=>wakes++);assert.equal(wakes,2);
}));

test('选择安静不会假装完成；推迟会保留想法；忙碌会话不会丢掉想法',()=>fixture(async({add,remember,tick,clock,call,store})=>{
  await add();const thought=await remember();clock.now+=6*minute;
  await tick(async()=>false);assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===thought.id).state,'pending');
  clock.now+=6*minute;await tick(async(t,context)=>{await call('qq_thought',{op:'defer',thought_id:t.id,reason:'等对方方便',delay_minutes:60},context);await call('qq_finish',{reason:'保留想法，稍后判断'},context);});
  assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===thought.id).state,'pending');
  clock.now+=61*minute;await tick(async(t,context)=>{await call('qq_finish',{reason:'没有自然的话题，继续安静'},context);});
  const saved=store.snapshot();assert.equal(saved.autonomous.thoughts.find(t=>t.id===thought.id).state,'dismissed');assert.match(saved.autonomous.decisions.at(-1).reason,/继续安静/);
}));

test('安静时段、关停、会话禁用、额度和过期想法均阻止后台唤醒',()=>fixture(async({settings,clock,add,remember,tick,store,autonomy,ctx})=>{
  await add();const thought=await remember();clock.now+=6*minute;let wakes=0;
  settings.social.proactiveEnabled=false;await tick(async()=>wakes++);settings.social.proactiveEnabled=true;
  const current=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hourCycle:'h23'}).format(new Date(clock.now)));
  settings.social.quietStartHour=current;settings.social.quietEndHour=(current+1)%24;assert.equal(quietTime(settings,clock.now),true);await tick(async()=>wakes++);
  settings.social.quietStartHour=0;settings.social.quietEndHour=0;settings.social.autonomousDecisionsPerDay=0;await tick(async()=>wakes++);
  settings.social.autonomousDecisionsPerDay=24;clock.now+=6*minute;
  await store.update(d=>d.profiles.push({chat:'private:20001',persona:'',responseMode:'inherit',keywords:[],probability:10,proactive:false}));await tick(async()=>wakes++);
  assert.equal(wakes,0);await store.update(d=>{d.profiles=[];d.autonomous.thoughts.find(t=>t.id===thought.id).expires=clock.now-1;});clock.now+=6*minute;
  await tick(async(t)=>{assert.notEqual(t.id,thought.id);});assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===thought.id).state,'expired');
}));

test('取消正在执行的想法或执行前关闭功能，后续 QQ 工具不会发出动作',()=>fixture(async({settings,add,remember,tick,clock,store,media,call,calls})=>{
  await add();const t=await remember();clock.now+=6*minute;
  await tick(async(thought,context)=>{
    await socialAdmin({op:'delete',section:'thoughts',id:thought.id},store,media);
    await assert.rejects(call('qq_reply',{text:'不应该发'},context),/取消|停止/);
    await call('qq_finish',{reason:'管理员取消了想法'},context);
  });
  assert.equal(store.snapshot().autonomous.thoughts.find(x=>x.id===t.id).state,'dismissed');assert.equal(calls.filter(c=>c.action==='send_private_msg').length,0);
  await remember({summary:'另一个想法'});clock.now+=61*minute;
  await tick(async(t,context)=>{settings.social.proactiveEnabled=false;await assert.rejects(call('qq_reply',{text:'不发'},context),/关闭/);});
}));

test('自主发送结果不明后不追发，且每轮最多两条、不能跨会话或执行申请等操作',()=>fixture(async({add,remember,tick,clock,call,engine,store,calls,overrides})=>{
  await add();await remember();clock.now+=6*minute;
  await tick(async(t,context)=>{
    await assert.rejects(engine.send(context,[{type:'text',data:{text:'越界'}}],'private:20002'),/跨会话/);
    await assert.rejects(call('qq_handle_request',{event_id:'fake',approve:true},context),/不允许/);
    await call('qq_reply',{text:'一句'},context);await call('qq_reply',{text:'再一句'},context);
    await assert.rejects(call('qq_reply',{text:'第三句'},context),/两条/);
  });assert.equal(calls.filter(c=>c.action==='send_private_msg').length,2);
  await add(2);await remember({message_id:2,summary:'有新消息后再聊'});clock.now+=61*minute;
  overrides.send_private_msg=async()=>{throw new Error('请求中断，是否发送未知');};await tick(async(t,context)=>call('qq_reply',{text:'待核对'},context));
  assert.equal(store.snapshot().autonomous.decisions.at(-1).outcome,'unknown');assert.equal(store.snapshot().autonomous.contacts[0].unanswered,1);
}));

test('后台图片任务安静收藏到真实协议列表，按日限制新增；对话直接收藏仍可用',()=>fixture(async({settings,add,tick,clock,call,store,favorites,calls,file,media})=>{
  settings.social.autoCollectStickers=true;settings.social.autoCollectPerDay=1;settings.budgets.proactiveMessagesPerDay=0;
  await add(1,'private:20001','[图片]',[{type:'image',data:{file}}]);clock.now+=6*minute;
  await tick(async(t,context)=>{
    assert.equal(t.kind,'collect');await assert.rejects(call('qq_reply',{text:'收藏提示'},context),/不允许/);
    await completeCollection(await call('qq_collect_sticker',{message_id:1},context),{message_id:1},args=>call('qq_collect_sticker',args,context));
    await call('qq_finish',{reason:'喜欢这张表情，已收藏，安静结束'},context);
  });assert.equal(favorites.items.length,1);assert.equal(store.snapshot().autonomous.decisions.at(-1).outcome,'done');
  assert.equal(calls.filter(c=>c.action==='send_private_msg').length,0);
  const other=await media.save(gif,'.gif');await add(2,'private:20001','[图片]',[{type:'image',data:{file:other}}]);clock.now+=6*minute;
  let wakes=0;await tick(async()=>wakes++);assert.equal(wakes,0);
  await completeCollection(await call('qq_collect_sticker',{message_id:2}),{message_id:2},args=>call('qq_collect_sticker',args));assert.equal(favorites.items.length,2);
}));

test('空间有独立机会且不依赖好友会话；限制读取聊天、发消息和重复发布',()=>fixture(async({settings,tick,publish,call,store,calls,usage})=>{
  settings.social.autoQzoneEnabled=true;settings.features.qzone.enabled=true;settings.features.qzone.requireConfirm=false;
  await tick(async(t,context)=>{
    assert.equal(t.kind,'qzone');assert.equal(t.chat,'');
    await assert.rejects(call('qq_recent_messages',{},context),/不允许/);await assert.rejects(call('qq_reply',{text:'草稿'},context),/不允许/);
    await call('qq_interest',{topic:'公开的猫猫趣事',reason:'独立创作兴趣'},context);
    await publish(context);await assert.rejects(publish(context,'同轮再发一条'),/已经发布/);
  });assert.equal(calls.filter(c=>c.action==='send_qzone_msg').length,1);assert.equal(usage.used('autonomous-qzone'),1);
  assert.equal(store.snapshot().autonomous.decisions.at(-1).outcome,'done');assert.equal(store.snapshot().autonomous.posts[0].state,'success');
}));

test('空间没有有效 tid 或请求中断时记为待核对，不重发同文，不把草稿当成功',()=>fixture(async({settings,tick,publish,clock,store,overrides})=>{
  settings.social.autoQzoneEnabled=true;settings.social.autoQzonePerDay=3;settings.features.qzone.enabled=true;settings.features.qzone.requireConfirm=false;settings.features.qzone.dailyLimit=5;
  overrides.send_qzone_msg=async()=>({});await tick(async(t,context)=>publish(context));
  assert.equal(store.snapshot().autonomous.decisions.at(-1).outcome,'unknown');assert.equal(store.snapshot().autonomous.posts[0].state,'unknown');
  clock.now+=7*hour;await tick(async(t,context)=>{await assert.rejects(publish(context),/重复发布/);});
  assert.equal(store.snapshot().autonomous.posts.length,1);
}));

test('保存或推迟空间想法不能绕过配置的创作判断间隔',()=>fixture(async({settings,tick,clock,call})=>{
  settings.social.autoQzoneEnabled=true;settings.features.qzone.enabled=true;settings.features.qzone.requireConfirm=false;let wakes=0;
  await tick(async(t,context)=>{wakes++;await call('qq_thought',{kind:'qzone',summary:'以后写一条新感想',reason:'公开创作的未完想法',delay_minutes:1},context);await call('qq_finish',{reason:'先保留打算'},context);});
  clock.now+=6*minute;await tick(async()=>wakes++);assert.equal(wakes,1);
  clock.now+=6*hour;await tick(async()=>wakes++);assert.equal(wakes,2);
}));

test('空间任务拒绝本地、聊天缓存和内网配图，允许改为文字；捕获错误也不能掩盖未知结果',()=>fixture(async({settings,tick,publish,autonomy,store,overrides,call,file})=>{
  settings.social.autoQzoneEnabled=true;settings.features.qzone.enabled=true;settings.features.qzone.requireConfirm=false;
  await tick(async(t,context)=>{
    await assert.rejects(autonomy.publish(context,'配图',[file],async()=>{throw new Error('不应调用');}),/不能读取本地/);
    await assert.rejects(autonomy.publish(context,'配图',['http://127.0.0.1/private'],async()=>{throw new Error('不应调用');}),/内网/);
    overrides.send_qzone_msg=async()=>({});await assert.rejects(publish(context),/tid/);
    await call('qq_finish',{reason:'模型声称已经成功'},context);
  });assert.equal(store.snapshot().autonomous.decisions.at(-1).outcome,'unknown');
}));

test('近期表情使用跨重启保留，搜索优先未用表情，自主聊天拒绝短期重复',()=>fixture(async({media,engine,store,autonomy,ctx,call,file})=>{
  const first=await engine.qqStickers.collect(file,ctx().signal),otherFile=await media.save(gif,'.gif'),second=await engine.qqStickers.collect(otherFile,ctx().signal);
  await store.update(d=>{for(const s of d.stickers)s.analysis={...mockStickerAnalysis,imageHash:imageHash(s.id===first.id?png:gif),at:Date.now()};});
  await call('qq_send_sticker',{sticker_id:first.id});assert.equal((await call('qq_stickers'))[0].id,second.id);
  const restarted=new SocialStore(store.path);await restarted.load();assert.equal(restarted.snapshot().autonomous.stickerUses[0].stickerId,first.id);
  await store.update(d=>d.autonomous.thoughts.push({id:'running',key:'running',chat:'private:20001',kind:'chat',summary:'聊天',reason:'测试',at:Date.now(),due:Date.now(),expires:Date.now()+hour,priority:80,state:'running',result:''}));
  await assert.rejects(call('qq_send_sticker',{sticker_id:first.id},ctx({proactive:true,autonomous:{kind:'chat',thoughtId:'running',effects:new Set(),messages:0,reason:''}})),/最近已/);
}));

test('管理端可查看、编辑兴趣、推迟或取消想法；记录冲突不会覆盖新内容',()=>fixture(async({add,remember,call,store,media,clock})=>{
  await add();const interest=await call('qq_interest',{topic:'猫猫',reason:'对方聊到了猫猫',message_id:1});const thought=await remember({expires_hours:72});
  await socialAdmin({op:'edit_interest',section:'interests',id:interest.id,text:'动物表情',expectedText:'猫猫'},store,media);
  await assert.rejects(socialAdmin({op:'edit_interest',section:'interests',id:interest.id,text:'旧编辑',expectedText:'猫猫'},store,media),/其他操作修改/);
  await socialAdmin({op:'defer_thought',section:'thoughts',id:thought.id},store,media);
  assert.equal((await socialAdmin({op:'list',section:'thoughts'},store,media)).rows[0].status,'等待判断');
  await socialAdmin({op:'delete',section:'thoughts',id:thought.id},store,media);await socialAdmin({op:'delete',section:'interests',id:interest.id},store,media);
  assert.equal(store.snapshot().autonomous.interests.length,0);assert.equal(store.snapshot().autonomous.thoughts.find(t=>t.id===thought.id).state,'dismissed');
}));

test('撤回和屏蔽的消息不能产生新想法；后台任务也不执行失效的来源',()=>fixture(async({add,remember,call,store,settings,tick,clock})=>{
  await add();const t=await remember();await store.update(d=>{d.messages[0].recalled=true;});
  await assert.rejects(call('qq_interest',{topic:'过期',reason:'不能引用撤回',message_id:1}),/撤回/);
  clock.now+=6*minute;let wakes=0;await tick(async()=>wakes++);assert.equal(wakes,0);
  await store.update(d=>{d.messages[0].recalled=false;});settings.social.blockedUsers=['20001'];
  await assert.rejects(remember({summary:'屏蔽后不能记'}),/屏蔽/);clock.now+=6*minute;await tick(async()=>wakes++);assert.equal(wakes,0);
}));
