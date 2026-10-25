import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SocialStore } from '../dist/social-store.js';
import { MediaService } from '../dist/media.js';
import { QqStickers } from '../dist/qq-stickers.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { socialAdmin } from '../dist/social-admin.js';
import { imageHash } from '../dist/sticker-review.js';
import { fakeQqFavorites, mockStickerAnalysis } from './helpers/sticker-review.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64');
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const md5=buffer=>createHash('md5').update(buffer).digest('hex');
async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'qq-favorites-'));
  try {
    const store=new SocialStore(join(dir,'social.json'));await store.load();await store.account(10000);
    const media=new MediaService(join(dir,'media'),()=>DEFAULT_SETTINGS.social),file=await media.save(png,'.png');
    const favorites=fakeQqFavorites(),overrides={};
    const api={hasLocalMedia:true,call:async(action,args,signal)=>{
      signal?.throwIfAborted();if(overrides[action])return overrides[action](args);
      const result=await favorites.protocol(action,args);if(!result.matched)throw new Error('unexpected API '+action);return result.data;
    }};
    const stickers=new QqStickers(store,media,api),signal=new AbortController().signal;
    const native=(extra={})=>({resId:'native-resource',emoId:7,md5:md5(png).toUpperCase(),emoOriginalPath:file,url:'',desc:'QQ 已收藏的图片',...extra});
    const legacy=async()=>store.update(d=>d.stickers.push({id:'old',file,note:'原有理解备注',tags:['开心'],uses:3,at:1,qqPresent:false,analysis:{...mockStickerAnalysis,imageHash:imageHash(png),at:1}}));
    const live={refresh:async()=>{},reset:async()=>{},stickers:{sync:()=>stickers.sync(signal),collect:id=>stickers.collectLegacy(id,signal),remove:id=>stickers.remove(id,signal)}};
    await run({dir,store,media,file,favorites,overrides,api,stickers,signal,native,legacy,live});
  } finally {await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('本地旧表情不冒充 QQ 收藏；刷新不擅自上传，显式补存后按 MD5 保留原理解与编号',()=>fixture(async({store,media,legacy,favorites,stickers,signal})=>{
  await legacy();await stickers.sync(signal);
  assert.equal(favorites.items.length,0);assert.equal(store.snapshot().stickers[0].qqPresent,false);
  const pending=await socialAdmin({op:'list',section:'stickers'},store,media);
  assert.match(pending.rows[0].status,/仅本地/);assert.match(pending.rows[0].detail,/尚未写入 QQ 收藏/);
  await stickers.collectLegacy('old',signal);
  const item=store.snapshot().stickers[0];assert.equal(item.id,'old');assert.equal(item.qqPresent,true);
  assert.equal(item.qq.resId,favorites.items[0].resId);assert.equal(item.qq.md5,md5(png));assert.equal(item.uses,3);
  assert.equal(item.analysis.meaning,mockStickerAnalysis.meaning);
  const restarted=new SocialStore(store.path);await restarted.load();assert.deepEqual(restarted.snapshot().stickers[0],item);
}));

test('QQ 原有收藏可从空本地库导入；MD5 大小写归一，缓存和含义记录可独立补充',()=>fixture(async({store,stickers,favorites,native,signal,file})=>{
  favorites.items.push(native());await stickers.sync(signal);
  const item=store.snapshot().stickers[0];assert.equal(item.qqPresent,true);assert.equal(item.file,'');assert.equal(item.analysis,undefined);
  assert.equal(item.md5,md5(png));assert.equal(item.qq.emojiId,'7');
  const image=await stickers.image(item.id,signal);assert.deepEqual(Buffer.from(image.data,'base64'),png);
  assert.equal(store.snapshot().stickers[0].file,file);
  assert.equal(favorites.calls.filter(c=>c.action==='add_custom_face').length,0);
}));

test('已在 QQ 的同图和并发收藏均只写一次，成功必须能从原生列表回读',()=>fixture(async({stickers,store,favorites,file,signal})=>{
  let reserved=0;const results=await Promise.all([stickers.collect(file,signal,async()=>{reserved++;}),stickers.collect(file,signal,async()=>{reserved++;})]);
  assert.equal(results[0].id,results[1].id);assert.equal(reserved,1);assert.equal(favorites.items.length,1);
  assert.equal(store.snapshot().stickers.length,1);assert.equal(favorites.calls.filter(c=>c.action==='add_custom_face').length,1);
  const addIndex=favorites.calls.findIndex(c=>c.action==='add_custom_face');
  assert.equal(favorites.calls[addIndex+1].action,'fetch_custom_face_detail');assert.equal(results[0].qqPresent,true);
}));

test('协议 HTTP 成功但原生添加失败、或列表没有新图时，均不得宣称 QQ 收藏成功',()=>fixture(async({stickers,store,overrides,file,signal})=>{
  overrides.add_custom_face=async()=>({result:7,errMsg:'QQ 收藏容量不足'});
  await assert.rejects(stickers.collect(file,signal),/容量不足/);
  assert.equal(store.snapshot().stickers.length,0);
  overrides.add_custom_face=async()=>({result:0,errMsg:''});
  await assert.rejects(stickers.collect(file,signal),/尚未回读/);
  assert.equal(store.snapshot().stickers.length,0);
}));

test('添加已到 QQ 但传输报错时，以列表回读为准；重试不会重复添加',()=>fixture(async({stickers,store,overrides,favorites,file,signal})=>{
  let added=0;
  overrides.add_custom_face=async args=>{added++;await favorites.protocol('add_custom_face',args);throw new Error('响应传输中断');};
  await stickers.collect(file,signal);await stickers.collect(file,signal);
  assert.equal(added,1);assert.equal(store.snapshot().stickers[0].qqPresent,true);
}));

test('从 QQ 收藏移除使用真实 res_id 并回读；保留理解缓存且刷新不自动加回',()=>fixture(async({stickers,store,favorites,file,signal})=>{
  const item=await stickers.collect(file,signal);await stickers.remove(item.id,signal);
  assert.equal(favorites.items.length,0);assert.equal(store.snapshot().stickers[0].qqPresent,false);
  assert.equal(store.snapshot().stickers[0].file,file);await stickers.sync(signal);
  const deleted=favorites.calls.find(c=>c.action==='delete_custom_face');assert.deepEqual(deleted.args,{res_id:item.qq.resId});
  assert.equal(favorites.calls.filter(c=>c.action==='add_custom_face').length,1);
  await assert.rejects(stickers.image(item.id,signal),/不在 QQ 收藏/);
}));

test('删除接口失败或实际未移除时保留 QQ 状态；不会只删本地后声称成功',()=>fixture(async({stickers,store,overrides,file,signal})=>{
  const item=await stickers.collect(file,signal);
  overrides.delete_custom_face=async()=>({result:9,errMsg:'删除被拒绝'});
  await assert.rejects(stickers.remove(item.id,signal),/删除被拒绝/);
  overrides.delete_custom_face=async()=>({result:0});
  await assert.rejects(stickers.remove(item.id,signal),/尚未确认移除/);
  assert.equal(store.snapshot().stickers[0].qqPresent,true);
}));

test('QQ 客户端外部删除会同步隐藏；缓存缺失可重新取图，缓存篡改或错图则拒绝',()=>fixture(async({stickers,store,favorites,file,signal,media,dir,native})=>{
  const item=await stickers.collect(file,signal),outside=join(dir,'napcat-original.png');await writeFile(outside,png);
  favorites.items[0].emoOriginalPath=outside;await rm(file);
  assert.deepEqual(Buffer.from((await stickers.image(item.id,signal)).data,'base64'),png);
  await writeFile(store.snapshot().stickers[0].file,gif);
  await assert.rejects(stickers.image(item.id,signal),/不一致/);
  favorites.items.splice(0);await stickers.sync(signal);
  assert.equal((await socialAdmin({op:'list',section:'stickers'},store,media)).rows.length,0);
  const wrong=await media.save(gif,'.gif');favorites.items.push(native({emoOriginalPath:wrong}));
  await store.update(d=>{d.stickers[0].file='';});
  await assert.rejects(stickers.image(item.id,signal),/MD5 不一致/);
}));

test('账号不一致、远程协议端及不支持收藏接口时明确失败，不降级成本地收藏',()=>fixture(async({stickers,store,overrides,api,file,signal,favorites})=>{
  overrides.get_login_info=async()=>({user_id:20000});await assert.rejects(stickers.collect(file,signal),/账号与社交数据不匹配/);
  delete overrides.get_login_info;api.hasLocalMedia=false;
  await assert.rejects(stickers.collect(file,signal),/协议端在远程/);assert.equal(favorites.items.length,0);
  api.hasLocalMedia=true;overrides.fetch_custom_face_detail=async()=>{throw new Error('不支持 fetch_custom_face_detail');};
  await assert.rejects(stickers.collect(file,signal),/不支持/);assert.equal(store.snapshot().stickers.length,0);
}));

test('桌面补存/刷新/移除均调用 QQ；离线只读缓存，不冒充已同步',()=>fixture(async({legacy,store,media,live,favorites})=>{
  await legacy();const pending=await socialAdmin({op:'list',section:'stickers'},store,media);
  assert.match(pending.note,/离线缓存/);
  await assert.rejects(socialAdmin({op:'collect_sticker',section:'stickers',id:'old'},store,media),/启动机器人/);
  const saved=await socialAdmin({op:'collect_sticker',section:'stickers',id:'old'},store,media,live);
  assert.match(saved.rows[0].status,/QQ收藏/);assert.equal(favorites.items.length,1);
  await assert.rejects(socialAdmin({op:'delete',section:'stickers',id:'old'},store,media),/启动机器人/);
  const removed=await socialAdmin({op:'delete',section:'stickers',id:'old'},store,media,live);
  assert.equal(removed.rows.length,0);assert.equal(favorites.items.length,0);
}));

test('远程协议返回的本机路径不能授权读取；仅可信本机协议收藏缓存可用',()=>fixture(async({stickers,api,favorites,native,signal,store,dir})=>{
  const outside=join(dir,'private.png');await writeFile(outside,png);favorites.items.push(native({emoOriginalPath:outside}));
  api.hasLocalMedia=false;await stickers.sync(signal);
  await assert.rejects(stickers.image(store.snapshot().stickers[0].id,signal),/受控|本地|媒体|路径/);
  api.hasLocalMedia=true;assert.deepEqual(Buffer.from((await stickers.image(store.snapshot().stickers[0].id,signal)).data,'base64'),png);
}));
