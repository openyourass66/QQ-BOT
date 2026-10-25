import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../dist/qq/social-store.js';
import { SocialEngine } from '../dist/qq/social-engine.js';
import { MediaService } from '../dist/services/media.js';
import { DailyUsageStore } from '../dist/core/usage.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';
import { StickerReviews, imageHash } from '../dist/qq/sticker-review.js';
import { socialAdmin } from '../dist/qq/social-admin.js';
import { fakeQqFavorites } from './helpers/sticker-review.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64');
const analysis=()=>({description:'测试表情中的人物微笑鼓掌',image_text:'你真棒',meaning:'用夸奖的字面意思表达反讽',emotions:['无奈','嘲讽'],usage:['熟悉朋友间委婉吐槽'],avoid:['严肃求助与安慰场景'],tags:['阴阳怪气','反讽'],confidence:'high'});
async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'qq-sticker-understanding-'));
  try {
    const settings=structuredClone(DEFAULT_SETTINGS),store=new SocialStore(join(dir,'social.json'));await store.load();await store.account(10000);
    const usage=new DailyUsageStore(join(dir,'usage.json'));await usage.load();const calls=[];
    const media=new MediaService(join(dir,'media'),()=>settings.social),file=await media.save(png,'.png');
    for(const [chat,id]of [['group:30001',1],['group:30001',2],['group:30002',1]])await store.add({chat,id,user:20001,name:'甲',at:Date.now(),text:'[图片]',self:false,recalled:false,segments:[{type:'image',data:{file}}]});
    const favorites=fakeQqFavorites();const api={hasLocalMedia:true,call:async(action,params)=>{const favorite=await favorites.protocol(action,params);if(favorite.matched)return favorite.data;calls.push({action,params});return {message_id:101};}};
    const engine=new SocialEngine(store,media,api,usage,()=>settings,async()=>true,()=>{},()=>{});
    const ctx=(extra={})=>({chat:'group:30001',self:10000,user:20001,sent:0,silent:false,signal:new AbortController().signal,...extra});
    const call=(tool,args={},context=ctx())=>engine.execute({action:'social',tool,args},context);
    const finish=(preview,extra={})=>call(preview.next_tool,{...(preview.message_id!==undefined?{message_id:preview.message_id}:{sticker_id:preview.sticker_id}),analysis_token:preview.analysis_token,analysis:analysis(),...extra});
    await run({dir,settings,store,media,engine,ctx,call,finish,file,calls,favorites});
  } finally {await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('首次收藏必须返回原图供理解，单独备注、伪造凭证或不完整分析均不能入库',()=>fixture(async({call,finish,store})=>{
  const preview=await call('qq_collect_sticker',{message_id:1,note:'随手猜的开心'});
  assert.equal(preview.status,'needs_analysis');assert.equal(preview.collected,false);assert.equal(preview.sent,false);
  const image=preview.content.find(c=>c.type==='image');assert.ok(image);assert.deepEqual(Buffer.from(image.data,'base64'),png);
  assert.equal(store.snapshot().stickers.length,0);assert.equal(store.snapshot().actions.length,0);
  await assert.rejects(call('qq_collect_sticker',{message_id:1,note:'开心',analysis_token:preview.analysis_token}),/完整 analysis/);
  await assert.rejects(call('qq_collect_sticker',{message_id:1,analysis:analysis()}),/原图分析凭证/);
  await assert.rejects(finish(preview,{analysis_token:'forged-token'}),/凭证/);
  await assert.rejects(finish(preview,{analysis:{...analysis(),meaning:'  '}}));
  assert.equal(store.snapshot().stickers.length,0);
}));

test('分析绑定会话、操作者和原消息；并发提交只成功一次，复用已理解同图不重复入库',()=>fixture(async({call,finish,store,ctx})=>{
  const preview=await call('qq_collect_sticker',{message_id:1});
  const payload={message_id:1,analysis_token:preview.analysis_token,analysis:analysis()};
  await assert.rejects(call('qq_collect_sticker',payload,ctx({chat:'group:30002'})),/凭证/);
  await assert.rejects(call('qq_collect_sticker',payload,ctx({user:20002})),/凭证/);
  await assert.rejects(call('qq_collect_sticker',{...payload,message_id:2}),/凭证/);
  const results=await Promise.allSettled([finish(preview),finish(preview)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(store.snapshot().stickers.length,1);
  const reused=await call('qq_collect_sticker',{message_id:1});assert.equal(reused.reused,true);assert.equal(reused.collected,true);
  assert.equal(reused.id,store.snapshot().stickers[0].id);
  assert.equal(store.snapshot().actions.filter(a=>a.tool==='qq_collect_sticker'&&a.state==='success').length,1);
}));

test('画面、文字、情绪、含义与场景持久化；搜索匹配正向用途，不把禁用场景当成推荐',()=>fixture(async({dir,call,finish,store,media})=>{
  const saved=await finish(await call('qq_collect_sticker',{message_id:1}),{note:'原始名称',tags:['自定义标签']});
  assert.equal(saved.file,undefined);
  assert.equal(saved.analysis.imageHash,imageHash(png));assert.ok(saved.analysis.at>0);
  for(const query of ['反讽','微笑','你真棒','无奈','委婉吐槽','自定义标签','无奈 反讽'])assert.equal((await call('qq_stickers',{query}))[0].id,saved.id,query);
  assert.equal((await call('qq_stickers',{query:'严肃求助'})).length,0);
  const restarted=new SocialStore(join(dir,'social.json'));await restarted.load();assert.deepEqual(restarted.snapshot().stickers[0].analysis,saved.analysis);
  const view=await socialAdmin({op:'list',section:'stickers',query:'严肃求助'},store,media);
  assert.equal(view.rows.length,1);assert.match(view.rows[0].status,/已理解/);assert.match(view.rows[0].detail,/图片文字：你真棒/);assert.match(view.rows[0].detail,/不适用：严肃求助/);
}));

test('旧表情标为待理解，修改备注不能解锁发送，补看原图并分析后才能发送',()=>fixture(async({call,finish,store,file,calls,media,engine})=>{
  await store.update(d=>d.stickers.push({id:'legacy',file,note:'以前随手写的备注',tags:[],uses:0,at:1}));
  await engine.qqStickers.collectLegacy('legacy',new AbortController().signal);
  assert.equal((await call('qq_stickers'))[0].analysisStatus,'needs_analysis');
  assert.match((await socialAdmin({op:'list',section:'stickers'},store,media)).rows[0].status,/待理解/);
  const pending=await call('qq_send_sticker',{sticker_id:'legacy'});assert.equal(pending.sent,false);assert.equal(pending.collected,true);assert.equal(pending.next_tool,'qq_sticker_note');assert.equal(calls.length,0);
  await call('qq_sticker_note',{sticker_id:'legacy',note:'开心'});assert.equal(store.snapshot().stickers[0].analysis,undefined);
  const again=await call('qq_send_sticker',{sticker_id:'legacy'});assert.equal(again.status,'needs_analysis');assert.equal(calls.length,0);
  await assert.rejects(call('qq_sticker_note',{sticker_id:'legacy',analysis:analysis()}),/看原图/);
  await finish(again);const sent=await call('qq_send_sticker',{sticker_id:'legacy'});assert.equal(sent.sent,true);
  assert.equal(calls.filter(c=>c.action==='send_group_msg').length,1);assert.equal(store.snapshot().stickers[0].uses,1);
}));

test('低置信度不自动发送；重新看图分析可提高置信度，图片被替换则拒绝发送',()=>fixture(async({call,finish,store,file,calls})=>{
  const saved=await finish(await call('qq_collect_sticker',{message_id:1}),{analysis:{...analysis(),confidence:'low',meaning:'无法确认这个群内梗的含义'}});
  assert.equal((await call('qq_stickers'))[0].analysisStatus,'uncertain');
  await assert.rejects(call('qq_send_sticker',{sticker_id:saved.id}),/不确定/);assert.equal(calls.length,0);
  assert.equal((await call('qq_collect_sticker',{message_id:1})).status,'needs_analysis');
  const review=await call('qq_sticker_image',{sticker_id:saved.id});await finish(review);assert.equal(store.snapshot().stickers[0].analysis.confidence,'high');
  await writeFile(file,Buffer.from('tampered'));
  await assert.rejects(call('qq_send_sticker',{sticker_id:saved.id}));assert.equal(calls.length,0);assert.equal(store.snapshot().stickers[0].uses,0);
}));

test('分析原图变更、取消或对象被屏蔽时不提交；视觉服务失败不生成假理解记录',()=>fixture(async({call,finish,store,file,ctx,media,settings})=>{
  const preview=await call('qq_collect_sticker',{message_id:1});await writeFile(file,Buffer.from('changed'));
  await assert.rejects(finish(preview),/原图已变更/);assert.equal(store.snapshot().stickers.length,0);await writeFile(file,png);
  const controller=new AbortController();controller.abort();
  await assert.rejects(call('qq_collect_sticker',{message_id:1,analysis_token:preview.analysis_token,analysis:analysis()},ctx({signal:controller.signal})));
  settings.social.blockedUsers=['20001'];await assert.rejects(finish(preview),/屏蔽/);settings.social.blockedUsers=[];
  media.vision=async()=>{throw new Error('视觉服务不可用')};
  await assert.rejects(call('qq_collect_sticker',{message_id:1}),/视觉服务不可用/);assert.equal(store.snapshot().stickers.length,0);
  media.vision=async()=>({});await assert.rejects(call('qq_collect_sticker',{message_id:1}),/未取得可用/);assert.equal(store.snapshot().stickers.length,0);
}));

test('写入失败不声称收藏成功，分析凭证仍可重试；旧数据重载不被伪造为已理解',()=>fixture(async({dir,call,finish,store,file})=>{
  const preview=await call('qq_collect_sticker',{message_id:1});const original=store.update.bind(store);
  // 直接验证提交失败后的库状态；恢复正常存储后可以用同一份已看图分析重试。
  let writes=0;store.update=async fn=>{if(++writes===2)throw new Error('存储不可写');return original(fn);};await assert.rejects(finish(preview),/存储不可写/);assert.equal(store.snapshot().stickers.length,0);
  store.update=original;await finish(preview);assert.equal(store.snapshot().stickers.length,1);
  await store.update(d=>d.stickers.push({id:'old',file,note:'旧备注',tags:[],uses:0,at:1}));
  const loaded=new SocialStore(join(dir,'social.json'));await loaded.load();assert.equal(loaded.snapshot().stickers.find(s=>s.id==='old').analysis,undefined);
  assert.ok(JSON.parse(await readFile(join(dir,'social.json'),'utf8')).stickers.find(s=>s.id!=='old').analysis.meaning);
}));

test('分析凭证五分钟到期、容量有界，并绑定用户/会话/图片目标',()=>{
  let now=1000;const reviews=new StickerReviews(()=>now),target={chat:'group:1',user:2,messageId:3};
  const token=reviews.issue(target,'file','hash');assert.equal(reviews.require(token,target).file,'file');
  assert.throws(()=>reviews.require(token,{...target,messageId:4}),/凭证/);
  now+=300_000;assert.throws(()=>reviews.require(token,target),/过期/);
  const first=reviews.issue(target,'file','hash');for(let i=0;i<256;i++)reviews.issue({...target,messageId:i+10},'file','hash');assert.throws(()=>reviews.require(first,target),/凭证/);
});
