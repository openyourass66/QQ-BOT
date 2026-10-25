import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SocialStore } from '../dist/qq/social-store.js';
import { SocialEngine } from '../dist/qq/social-engine.js';
import { MediaService } from '../dist/services/media.js';
import { DailyUsageStore } from '../dist/core/usage.js';
import { QqActionPolicy } from '../dist/qq/qq-actions.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';
import { socialTools } from '../dist/qq/social-tools.js';
import { legacyTools } from '../dist/qq/legacy-tools.js';
import { startActionServer } from '../dist/services/action-server.js';
import { mockStickerAnalysis, fakeQqFavorites } from './helpers/sticker-review.mjs';

test('功能审计：全部 MCP 工具逐项经过真实传输、参数校验和受控协议/服务适配', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-tool-audit-'));
  const keys = ['BOT_MEDIA_BASE_URL','BOT_MEDIA_API_KEY','BOT_SEARCH_URL','BOT_QZONE_ADAPTER_URL','BOT_FFMPEG_BIN'];
  const saved = Object.fromEntries(keys.map(k => [k,process.env[k]]));
  const requests = [], calls = [], exercised = new Set();
  const http = createServer(async (req,res) => {
    let raw=''; for await(const c of req) raw+=c;
    requests.push({path:req.url,raw}); res.setHeader('content-type','application/json');
    if(req.url==='/audio/speech') { res.setHeader('content-type','audio/mpeg'); res.end(Buffer.from('test-mp3')); }
    else if(req.url==='/audio/transcriptions') res.end(JSON.stringify({text:'测试语音正文'}));
    else if(req.url==='/chat/completions') res.end(JSON.stringify({choices:[{message:{content:'图片中有测试图案'}}]}));
    else if(req.url==='/search') res.end(JSON.stringify({results:[{title:'测试来源',url:'https://example.com/source'}]}));
    else if(req.url==='/qzone') res.end(JSON.stringify(JSON.parse(raw).action==='feed'?{posts:[{id:'post-real',text:'动态'}]}:{commented:true}));
    else { res.statusCode=404;res.end('{}'); }
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const base=`http://127.0.0.1:${http.address().port}`;
  Object.assign(process.env,{BOT_MEDIA_BASE_URL:base+'/',BOT_MEDIA_API_KEY:'local-fixture',BOT_SEARCH_URL:base+'/search',BOT_QZONE_ADAPTER_URL:base+'/qzone'});
  delete process.env.BOT_FFMPEG_BIN;
  let client,actions;
  try {
    const settings=structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.social,{messagesPerMinute:100,actionsPerDay:1000,visionModel:'test-vision',transcriptionModel:'test-asr',speechModel:'test-tts'});
    settings.chat.group.proactive.enabled=true;settings.chat.group.proactive.perGroupPerDay=20;
    settings.budgets.proactiveMessagesPerDay=100;Object.assign(settings.features.qzone,{enabled:true,requireConfirm:false,dailyLimit:10});
    const store=new SocialStore(join(dir,'social.json'));await store.load();await store.account(10000);
    const usage=new DailyUsageStore(join(dir,'usage.json'));await usage.load();
    const media=new MediaService(join(dir,'media'),()=>settings.social);
    const png=await media.save(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64'),'.png');
    const text=await media.save(Buffer.from('文件正文：咖啡'),'.txt');
    const voice=await media.save(Buffer.from('test-audio'),'.wav');
    const video=await media.save(Buffer.from('test-video'),'.mp4');
    const favorites=fakeQqFavorites();const api={hasLocalMedia:true,async call(action,params,signal) {
      signal?.throwIfAborted();calls.push({action,params});
      const favorite=await favorites.protocol(action,params);if(favorite.matched)return favorite.data;
      if(action==='get_friend_list')return [{user_id:20001,nickname:'甲'}];
      if(action==='get_group_list')return [{group_id:30001,group_name:'测试群'}];
      if(action==='get_group_member_list')return [{user_id:20001,nickname:'甲'}];
      if(action==='get_login_info'||action==='get_group_member_info')return {user_id:10000,nickname:'小鲸'};
      if(action==='get_group_msg_history')return {messages:[{message_id:40,user_id:20001,time:1,message:'历史消息',sender:{nickname:'甲'}}]};
      if(action==='get_forward_msg')return {messages:[{content:'转发正文'}]};
      if(action==='get_group_root_files'||action==='get_group_files_by_folder')return {files:[{file_id:'file-real',file_name:'笔记.txt',busid:102}]};
      if(action==='get_group_file_url')return {file:text};
      if(action==='send_qzone_msg'){assert.equal(typeof params.content,'string');assert.ok(Array.isArray(params.images));assert.equal(params.message,undefined);return {tid:'post-fixture'};}
      if(action.startsWith('send_'))return {message_id:1000+calls.length};
      return {};
    }};
    const engine=new SocialEngine(store,media,api,usage,()=>settings,async()=>true,()=>{},()=>{});
    const policy=new QqActionPolicy(api,usage,()=>settings,async()=>true);
    const ctx=signal=>({chat:'group:30001',self:10000,user:20001,sent:0,silent:false,signal});
    const segment=(type,data)=>[{type,data}];
    const seed=async(id,segments,self=false)=>store.add({chat:'group:30001',id,user:self?10000:20001,name:'甲',at:Date.now(),text:'测试消息',segments,self,recalled:false});
    await seed(1,segment('text',{text:'测试消息'}));await seed(2,segment('image',{file:png}));
    await seed(3,segment('forward',{id:'forward-real'}));await seed(4,segment('record',{file:voice}));
    await seed(5,segment('video',{file:video}));await seed(6,segment('file',{file:text,name:'笔记.txt'}));await seed(7,segment('text',{text:'我的消息'}),true);
    const upload=await store.addEvent('group:30001','notice:group_upload',{file:{id:'file-real',name:'笔记.txt'}});
    const request=await store.addEvent('group:30001','request:group',{flag:'flag-real',sub_type:'invite'});
    actions=await startActionServer(async(input,signal,conversation)=>{
      assert.equal(conversation,'audit-context');const c=ctx(signal);
      if(input.action==='social')return engine.execute(input,c);
      if(input.action==='legacy') {
        const def=legacyTools.find(d=>d.name===input.tool);assert.ok(def);
        return engine.legacy(input.tool,z.object(def.schema).strict().parse(input.args),c);
      }
      if(input.action==='send_message')return engine.send(c,segment('text',{text:input.text}),`${input.target_type}:${input.target_id}`,true);
      if(input.action==='like')await engine.target(c,`private:${input.user_id}`);
      await engine.approve(c,input.action,input.action==='qzone_post');
      return policy.execute(input,signal,()=>engine.actionQuotas(c),()=>engine.recordAction(c.chat));
    });
    client=new Client({name:'feature-audit',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp-qq.js')],env:{BOT_ACTION_URL:actions.url,BOT_ACTION_TOKEN:actions.token,BOT_ACTION_CONTEXT:'audit-context'},stderr:'pipe'}));
    const registry=(await client.listTools()).tools;
    assert.equal(registry.length,53);assert.deepEqual(registry.map(d=>d.name).sort(),[...socialTools,...legacyTools].map(d=>d.name).sort());
    const call=async(name,args={},error)=>{
      let value;
      await t.test(name,async()=>{
        let result=await client.callTool({name,arguments:args});exercised.add(name);
        if(name==='qq_collect_sticker'&&!result.isError) {
          const preview=JSON.parse(result.content[0].text);
          if(preview.status==='needs_analysis')result=await client.callTool({name,arguments:{...args,analysis_token:preview.analysis_token,analysis:structuredClone(mockStickerAnalysis)}});
        }
        if(error){assert.equal(result.isError,true);assert.match(result.content[0].text,error);return;}
        assert.notEqual(result.isError,true,result.content?.[0]?.text);
        assert.ok(result.content.length);value=result.content[0].type==='text'?JSON.parse(result.content[0].text):result;
      });return value;
    };
    await call('qq_capabilities');await call('qq_reply',{text:'收到',reply_to:1,at_user:20001});
    await call('qq_self_state');await call('qq_interest',{topic:'咖啡',reason:'聊天提到了咖啡',message_id:1});
    await call('qq_thought',{summary:'以后继续聊咖啡',reason:'有实际话题可以延续',message_id:1});
    await call('qq_recent_messages',{refresh:true});await call('qq_message',{message_id:1});
    await call('qq_read_forward',{message_id:3});await call('qq_active_members');await call('qq_chats');await call('qq_poke',{user_id:20001});
    await call('qq_images',{message_id:2});await call('qq_send_image',{source:png});
    const sticker=await call('qq_collect_sticker',{message_id:2,note:'开心'});
    await call('qq_stickers');await call('qq_sticker_note',{sticker_id:sticker.id,note:'赞同'});
    await call('qq_sticker_image',{sticker_id:sticker.id});await call('qq_send_sticker',{sticker_id:sticker.id});
    const memory=await call('qq_memory_append',{user_id:20001,name:'甲',text:'喜欢咖啡'});
    await call('qq_memory_query');await call('qq_memory_remove',{memory_id:memory.id});await call('qq_finish',{reason:'无需回复'});
    const reminder=await call('qq_set_reminder',{text:'喝水',delay_minutes:5});await call('qq_reminders');await call('qq_cancel_reminder',{reminder_id:reminder.id});
    await call('qq_events');await call('qq_actions');await call('qq_handle_request',{event_id:request,approve:true});
    await call('qq_transcribe',{message_id:4});await call('qq_speak',{text:'你好'});
    await call('qq_video',{message_id:5},/FFmpeg/);
    await call('qq_file',{message_id:6});await call('qq_event_file',{event_id:upload});
    await call('qq_group_files');await call('qq_group_file',{file_id:'file-real'});
    const file=await call('qq_create_file',{name:'摘要.md',text:'# 摘要'});await call('qq_send_file',{source:file.file,name:file.name});
    await call('qq_search',{query:'测试'});await call('qq_web_read',{url:'http://127.0.0.1/private'},/本机或内网/);await call('qq_qzone_feed');await call('qq_qzone_comment',{post_id:'post-real',text:'收到'});await call('qq_report',{text:'审计记录'});
    await call('qq_send_message',{target_type:'private',target_id:20001,text:'跨会话'});await call('qq_like',{user_id:20001});await call('qq_qzone_post',{text:'测试动态'});
    await call('qq_get_friend_list');await call('qq_get_group_list');await call('qq_get_group_member_list',{group_id:30001});
    await call('qq_set_profile',{nickname:'小鲸',signature:'测试签名'});await call('qq_set_group_card',{group_id:30001,card:'小鲸'});
    await call('qq_set_avatar',{file:png});await call('qq_recall',{message_id:7});await call('qq_self_info',{group_id:30001});
    assert.equal(exercised.size,53);assert.equal(requests.length,8);
    for(const endpoint of ['send_group_msg','send_private_msg','send_like','send_qzone_msg','upload_group_file','set_qq_profile','set_self_longnick','set_group_card','set_qq_avatar','delete_msg','group_poke','set_group_add_request','add_custom_face','fetch_custom_face_detail'])assert.ok(calls.some(c=>c.action===endpoint),endpoint);
    assert.equal(favorites.items.length,1);assert.equal(store.snapshot().stickers[0].qqPresent,true);
    assert.equal(store.message('group:30001',7).recalled,true);
  } finally {
    await client?.close();await actions?.close();http.closeAllConnections();await new Promise(done=>http.close(done));
    for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test('媒体存储：并发写入不突破总容量，同内容去重且不留下半写入文件',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-media-audit-')),previous=process.env.BOT_MEDIA_MAX_BYTES;
  try {
    process.env.BOT_MEDIA_MAX_BYTES='3';const media=new MediaService(dir,()=>DEFAULT_SETTINGS.social);
    const results=await Promise.allSettled([media.save(Buffer.from('aa'),'.txt'),media.save(Buffer.from('bb'),'.txt')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const first=results.find(r=>r.status==='fulfilled').value;assert.equal(await media.save(await readFile(first),'.txt'),first);
    assert.equal((await readdir(dir)).length,1);assert.equal((await readFile(first)).length,2);
    await assert.rejects(media.save(Buffer.from('x'),'../outside'),/扩展名/);
  } finally {if(previous===undefined)delete process.env.BOT_MEDIA_MAX_BYTES;else process.env.BOT_MEDIA_MAX_BYTES=previous;await rm(dir,{recursive:true,force:true});}
});

test('动作总额度与专用额度一次预扣，专用额度拒绝不会消耗总额或限频',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-quota-audit-'));
  try {
    const settings=structuredClone(DEFAULT_SETTINGS);settings.social.messagesPerMinute=1;settings.budgets.likesPerDay=0;
    const usage=new DailyUsageStore(join(dir,'usage.json'));await usage.load();
    const store=new SocialStore(join(dir,'social.json'));await store.load();
    const api={call:async()=>({message_id:1})};const context={chat:'private:20001',self:10000,user:20001,signal:new AbortController().signal,sent:0,silent:false};
    const engine=new SocialEngine(store,new MediaService(join(dir,'media'),()=>settings.social),api,usage,()=>settings,async()=>true,()=>{},()=>{});
    const policy=new QqActionPolicy(api,usage,()=>settings,async()=>true);
    await assert.rejects(policy.execute({action:'like',user_id:20001,times:1},context.signal,()=>engine.actionQuotas(context),()=>engine.recordAction(context.chat)),/点赞今日额度不足/);
    await engine.normalReply(context,'第一次有效操作');
    const data=JSON.parse(await readFile(join(dir,'usage.json'),'utf8'));assert.equal(data.counters['social-actions'],1);assert.equal(data.counters.likes,undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});
