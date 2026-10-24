import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../dist/social-store.js';
import { SocialEngine, parseShanghaiTime } from '../dist/social-engine.js';
import { MediaService, downloadPublic } from '../dist/media.js';
import { DailyUsageStore } from '../dist/usage.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { allowedChat } from '../dist/social-settings.js';
import { socialAdmin } from '../dist/social-admin.js';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-social-'));
  const store = new SocialStore(join(dir,'social.json')); await store.load(); await store.account(10000);
  const usage = new DailyUsageStore(join(dir,'usage.json')); await usage.load();
  const settings = structuredClone(DEFAULT_SETTINGS); settings.social.messagesPerMinute = 100;
  const calls = []; let nextId = 100;
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_friend_list') return [{ user_id:20001,nickname:'甲' }];
    if (action === 'get_group_list') return [{ group_id:30001,group_name:'测试群' }];
    if (action === 'get_group_member_list') return [{ user_id:20001 }];
    if (action.startsWith('send_')) return { message_id:nextId++ };
    if (action === 'get_forward_msg') return { messages:[{ content:'转发内容' }] };
    return {};
  } };
  const media = new MediaService(join(dir,'media'), () => settings.social);
  const engine = new SocialEngine(store,media,api,usage,() => settings,async () => true,() => {},() => {});
  const ctx = () => ({ chat:'group:30001',self:10000,user:20001,sent:0,silent:false,signal:new AbortController().signal });
  const call = (tool,args={}, context=ctx()) => engine.execute({ action:'social',tool,args },context);
  try { await run({ dir,store,usage,settings,calls,api,media,engine,ctx,call }); }
  finally { await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
}
const entry = (id, extra={}) => ({ chat:'group:30001',id,user:20001,name:'甲',at:Date.now(),text:'测试',segments:[{type:'text',data:{text:'测试'}}],self:false,recalled:false,...extra });

test('回复当前会话不扣主动额度，引用与 @ 使用真实消息和群成员', () => fixture(async ({store,call,ctx,calls,usage}) => {
  await store.add(entry(-12)); const turn=ctx();
  const result=await call('qq_reply',{text:'收到',reply_to:-12,at_user:20001},turn);
  assert.equal(turn.sent,1); assert.equal(result.sent,true);
  assert.deepEqual(calls.find(c=>c.action==='send_group_msg').params.message,[{type:'reply',data:{id:'-12'}},{type:'at',data:{qq:'20001'}},{type:'text',data:{text:'收到'}}]);
  assert.equal(store.message(turn.chat,result.message_id).self,true);
  await assert.rejects(call('qq_reply',{text:'错',reply_to:999}),/找不到/);
  await assert.rejects(call('qq_reply',{text:'错',at_user:999}),/不是当前群成员/);
  await usage.flush();
}));
test('跨会话只允许现有联系人，屏蔽和名单热变更立即生效', () => fixture(async ({engine,ctx,settings,calls}) => {
  await engine.target(ctx(),'private:20001');
  await assert.rejects(engine.target(ctx(),'private:99999'),/不是现有/);
  settings.social.blockedUsers.push('20001');
  await assert.rejects(engine.target(ctx(),'private:20001'),/屏蔽/);
  assert.equal(allowedChat(settings.social,'group:30001',20001),false);
  settings.social.blockedUsers=[]; settings.social.allowAll=false;
  await assert.rejects(engine.normalReply(ctx(),'不能发'),/名单/);
  assert.equal(calls.some(c=>c.action==='send_group_msg'),false);
}));
test('记忆按会话和 QQ 隔离、去重、删除并跨重启恢复', () => fixture(async ({call,ctx,store,dir}) => {
  const a=await call('qq_memory_append',{user_id:20001,name:'甲',text:'喜欢咖啡'});
  const b=await call('qq_memory_append',{user_id:20001,name:'甲',text:'喜欢咖啡'}); assert.equal(a.id,b.id);
  assert.equal((await call('qq_memory_query')).length,1);
  assert.equal((await call('qq_memory_query',{}, {...ctx(),chat:'private:20001'})).length,0);
  const restarted=new SocialStore(join(dir,'social.json')); await restarted.load(); assert.equal(restarted.snapshot().memories.length,1);
  await call('qq_memory_remove',{memory_id:a.id}); assert.equal(store.snapshot().memories.length,0);
}));
test('表情收藏转存、备注、查看和发送闭环；不读取库外文件', () => fixture(async ({call,store,media,calls,dir,settings}) => {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64');
  const file=await media.save(png,'.png');
  await store.add(entry(1,{segments:[{type:'image',data:{file:'image-ref'}}]}));
  const original=media.bytes.bind(media); media.bytes=async (source,signal,max)=>source==='https://qq.example/p.png'?{buffer:png,mime:'image/png'}:original(source,signal,max);
  await store.update(d=>{d.messages[0].segments[0].data.url='https://qq.example/p.png';});
  const sticker=await call('qq_collect_sticker',{message_id:1,note:'开心',tags:['笑']});
  await call('qq_sticker_note',{sticker_id:sticker.id,note:'赞同',tags:['好']});
  assert.equal((await call('qq_stickers',{query:'赞同'})).length,1);
  assert.equal((await call('qq_sticker_image',{sticker_id:sticker.id})).content[0].type,'image');
  await call('qq_send_sticker',{sticker_id:sticker.id}); assert.equal(store.snapshot().stickers[0].uses,1);
  assert.ok(calls.some(c=>Array.isArray(c.params.message)&&c.params.message[0].type==='image'));
  await assert.rejects(media.bytes(join(dir,'social.json'),new AbortController().signal),/媒体库/);
  settings.social.stickersEnabled=false; await assert.rejects(call('qq_send_sticker',{sticker_id:sticker.id}),/关闭/);
}));
test('撤回核验自己的消息与会话，负消息 ID 可用；合并转发可展开', () => fixture(async ({store,call,engine,ctx,calls}) => {
  await store.add(entry(-1));
  await assert.rejects(engine.legacy('qq_recall',{message_id:-1},ctx()),/只能撤回/);
  await store.add(entry(-2,{user:10000,self:true}));
  await engine.legacy('qq_recall',{message_id:-2},ctx()); assert.equal(store.message(ctx().chat,-2).recalled,true);
  await store.add(entry(-3,{segments:[{type:'forward',data:{id:'forward-real-id'}}]}));
  assert.equal((await call('qq_read_forward',{message_id:-3})).messages[0].content,'转发内容');
  assert.equal(calls.find(c=>c.action==='get_forward_msg').params.message_id,'forward-real-id');
}));
test('提醒持久化、周期、额度、取消与中断后不重发', () => fixture(async ({call,engine,store,ctx,settings,calls,dir}) => {
  settings.chat.group.proactive.enabled=true;
  settings.chat.group.proactive.perGroupPerDay=5;
  await assert.rejects(call('qq_set_reminder',{text:'错',delay_minutes:1,at_time:'2026-12-01 08:00'}),/只能/);
  const task=await call('qq_set_reminder',{text:'喝水',delay_minutes:1});
  await store.update(d=>{d.tasks.find(t=>t.id===task.id).due=Date.now()-1;});
  await Promise.all([engine.tick(10000,ctx().signal,async()=>{}),engine.tick(10000,ctx().signal,async()=>{})]);
  assert.equal(calls.filter(c=>c.action==='send_group_msg').length,1);
  assert.equal(store.snapshot().tasks[0].state,'sent');
  const cancel=await call('qq_set_reminder',{text:'取消',delay_minutes:1}); await call('qq_cancel_reminder',{reminder_id:cancel.id});
  const interrupted=await call('qq_set_reminder',{text:'中断',delay_minutes:1}); await store.update(d=>{d.tasks.find(t=>t.id===interrupted.id).state='running';});
  const restarted=new SocialStore(join(dir,'social.json')); await restarted.load();
  assert.equal(restarted.snapshot().tasks.find(t=>t.id===interrupted.id).state,'unknown');
  assert.equal(parseShanghaiTime('2026-12-01 08:00'),Date.parse('2026-12-01T00:00:00Z'));
  assert.throws(()=>parseShanghaiTime('2026-02-30 08:00'),/无效/);
}));
test('真实申请事件只能处理一次，失败不自动重试未知结果', () => fixture(async ({store,call,calls}) => {
  const id=await store.addEvent('group:30001','request:group',{flag:'real-flag',sub_type:'invite'});
  await assert.rejects(call('qq_handle_request',{event_id:'fake',approve:true}),/不存在/);
  await call('qq_handle_request',{event_id:id,approve:true});
  await assert.rejects(call('qq_handle_request',{event_id:id,approve:true}),/已经处理/);
  assert.equal(calls.filter(c=>c.action==='set_group_add_request').length,1);
}));
test('媒体缺少服务时明确不可用；下载拒绝内网与非 HTTP；决定潜水不发送', () => fixture(async ({call,ctx,media}) => {
  const signal=ctx().signal;
  await assert.rejects(downloadPublic('http://127.0.0.1/secret',signal),/内网/);
  await assert.rejects(downloadPublic('file:///secret',signal),/无效/);
  await assert.rejects(media.speech('hello',signal),/未配置/);
  await assert.rejects(call('qq_qzone_feed'),/未配置/);
  const context=ctx(); await call('qq_finish',{reason:'这段与我无关',active_topic:'咖啡'},context);
  assert.equal(context.silent,true); assert.equal(context.topic,'咖啡'); assert.equal(context.sent,0);
}));
test('持久化失败不发消息，损坏文件保留，账号隔离', () => fixture(async ({engine,ctx,dir,store,calls}) => {
  await assert.rejects(store.account(99999),/不匹配/);
  const bad=new SocialStore(join(dir,'broken.json')); await writeFile(bad.path,'{bad'); await assert.rejects(bad.load()); assert.equal(await readFile(bad.path,'utf8'),'{bad');
  await rm(store.path); await mkdir(store.path);
  await assert.rejects(engine.execute({action:'social',tool:'qq_reply',args:{text:'不会发出'}},ctx()));
  assert.equal(calls.filter(c=>c.action==='send_group_msg').length,0);
}));
test('控制台记录列表显示动作和会话，记忆管理不改变其他记录', () => fixture(async ({call,store,media}) => {
  const m=await call('qq_memory_append',{user_id:20001,name:'甲',text:'旧记忆'});
  await socialAdmin({op:'edit_memory',section:'memories',id:m.id,text:'新记忆'},store,media);
  const view=await socialAdmin({op:'list',section:'memories'},store,media); assert.equal(view.rows[0].text,'新记忆');
  await socialAdmin({op:'delete',section:'memories',id:m.id},store,media);
  assert.equal(store.snapshot().memories.length,0); assert.ok(store.snapshot().actions.length>0);
}));
test('生成文件、发送文件和动作核对形成闭环；每会话人设持久化', () => fixture(async ({call,store,media,calls,ctx}) => {
  const file=await call('qq_create_file',{name:'聊天摘要.md',text:'# 今天\n喝咖啡'});
  const turn=ctx(); await call('qq_send_file',{source:file.file,name:file.name},turn);
  assert.equal(turn.sent,1); assert.equal(calls.find(c=>c.action==='upload_group_file').params.name,'聊天摘要.md');
  assert.ok((await call('qq_actions')).some(a=>a.tool==='qq_send_file'&&a.summary.includes('聊天摘要')));
  await socialAdmin({op:'profile',chat:'group:30001',text:'安静的群友',responseMode:'keywords',keywords:'咖啡,天气',probability:20,proactive:false},store,media);
  assert.equal(store.snapshot().profiles[0].persona,'安静的群友');
  assert.deepEqual(store.snapshot().profiles[0].keywords,['咖啡','天气']);
}));
test('周期提醒重新安排未来执行；主动机会受间隔与会话开关限制', () => fixture(async ({call,store,engine,ctx,settings}) => {
  settings.chat.group.proactive.enabled=true; settings.chat.group.proactive.perGroupPerDay=5;
  const task=await call('qq_set_reminder',{text:'周期提醒',delay_minutes:1,interval_minutes:5});
  await store.update(d=>{d.tasks.find(t=>t.id===task.id).due=Date.now()-1;});
  await engine.tick(10000,ctx().signal,async()=>{});
  assert.equal(store.snapshot().tasks[0].state,'pending'); assert.ok(store.snapshot().tasks[0].due>Date.now());
  await call('qq_cancel_reminder',{reminder_id:task.id});
  settings.social.proactiveEnabled=true;settings.social.proactiveIntervalMinutes=5;settings.social.quietStartHour=0;settings.social.quietEndHour=0;
  await store.add(entry(9));
  let wakes=0;const real=Date.now;let now=real();Date.now=()=>now;
  try {
    await engine.tick(10000,ctx().signal,async()=>wakes++);assert.equal(wakes,0);
    now+=6*60000;
    await engine.tick(10000,ctx().signal,async()=>wakes++);assert.equal(wakes,1);
    await engine.tick(10000,ctx().signal,async()=>wakes++);assert.equal(wakes,1);
    await store.update(d=>{d.profiles.push({chat:'group:30001',persona:'',responseMode:'inherit',keywords:[],probability:10,proactive:false});});
    now+=6*60000;await engine.tick(10000,ctx().signal,async()=>wakes++);assert.equal(wakes,1);
  } finally {Date.now=real;}
}));
