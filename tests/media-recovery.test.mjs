import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { OneBotHttp } from '../dist/onebot.js';
import { SocialEngine } from '../dist/social-engine.js';
import { SocialStore } from '../dist/social-store.js';
import { DailyUsageStore } from '../dist/usage.js';
import { MediaService, downloadPublic } from '../dist/media.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { completeCollection } from './helpers/sticker-review.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64');
const signal=()=>new AbortController().signal;

test('QQ 图片解析到 Fake-IP 时，通过本机 OneBot 缓存完成看图、收藏、重启恢复与发送',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-image-recovery-')),calls=[];
  const file=join(root,'qq-cache.png');await writeFile(file,png);
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const args=JSON.parse(raw||'{}');calls.push({action:req.url,args});
    assert.equal(req.headers.authorization,'Bearer fixture-token');let data;
    if(req.url==='/get_image'){
      if(args.file==='expired-reference'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'failed',retcode:200,message:'file not found'}));return;}
      assert.equal(args.file,'recorded-image-reference');data={file,url:'https://198.18.0.115/qq-image.png'};
    }
    else if(req.url==='/send_group_msg'){const sent=fileURLToPath(args.message[0].data.file);assert.ok(sent.startsWith(join(root,'media')));assert.deepEqual(await readFile(sent),png);data={message_id:101};}
    else throw new Error('意外的协议调用');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const settings=structuredClone(DEFAULT_SETTINGS),store=new SocialStore(join(root,'social.json'));
    await store.load();await store.account(10000);
    await store.add({chat:'group:30001',id:1,user:20001,name:'甲',at:Date.now(),text:'[图片]',self:false,recalled:false,segments:[{type:'image',data:{file:'recorded-image-reference',url:'https://198.18.0.115/qq-image.png'}}]});
    const usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();
    const api=new OneBotHttp(`http://127.0.0.1:${server.address().port}`,'fixture-token');
    const media=new MediaService(join(root,'media'),()=>settings.social);
    const engine=new SocialEngine(store,media,api,usage,()=>settings,async()=>true,()=>{},()=>{});
    const context=()=>({chat:'group:30001',self:10000,user:20001,sent:0,silent:false,signal:signal()});
    const call=async(tool,args={})=>{const invoke=args=>engine.execute({action:'social',tool,args},context()),result=await invoke(args);return tool==='qq_collect_sticker'?completeCollection(result,args,invoke):result;};
    const image=await call('qq_images',{message_id:1});assert.equal(image.content.at(-1).type,'image');assert.deepEqual(Buffer.from(image.content.at(-1).data,'base64'),png);
    const sticker=await call('qq_collect_sticker',{message_id:1,note:'开心',tags:['笑']});
    const savedFile=store.snapshot().stickers.find(s=>s.id===sticker.id).file;
    assert.deepEqual(await readFile(savedFile),png);assert.notEqual(savedFile,file);assert.equal(sticker.file,undefined);
    assert.equal((await call('qq_collect_sticker',{message_id:1,note:'开心'})).id,sticker.id);
    const restored=new SocialStore(join(root,'social.json'));await restored.load();assert.equal(restored.snapshot().stickers.length,1);
    await call('qq_send_sticker',{sticker_id:sticker.id});assert.equal(store.snapshot().stickers[0].uses,1);
    assert.ok(calls.some(c=>c.action==='/get_image'));assert.equal(calls.filter(c=>c.action==='/send_group_msg').length,1);
    const before=calls.length;
    await assert.rejects(call('qq_send_image',{source:file,preview:true}),/媒体库/);
    await assert.rejects(call('qq_send_image',{source:'http://127.0.0.1/private',preview:true}),/内网/);
    for(const [id,source]of [[2,'http://127.0.0.1/private'],[3,file]]) {
      await store.add({chat:'group:30001',id,user:20001,name:'甲',at:Date.now(),text:'[图片]',self:false,recalled:false,segments:[{type:'image',data:{file:source}}]});
      await assert.rejects(call('qq_images',{message_id:id}),/内网|媒体库/);
    }
    assert.equal(calls.length,before,'任意工具路径和内网 URL 不能借图片回退读取');
    const aborted=context();const controller=new AbortController();controller.abort();aborted.signal=controller.signal;
    await assert.rejects(engine.execute({action:'social',tool:'qq_images',args:{message_id:1}},aborted));assert.equal(calls.length,before);
    await store.add({chat:'group:30001',id:4,user:20001,name:'甲',at:Date.now(),text:'[图片]',self:false,recalled:false,segments:[{type:'image',data:{file:'expired-reference',url:'https://198.18.0.115/expired.png'}}]});
    await assert.rejects(call('qq_images',{message_id:4}),/重新发送图片/);
  } finally {server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('协议图片导入只读取本机接口缓存或返回的图片字节，远程接口不能授权任意本地文件',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-image-boundary-'));
  try {
    const file=join(root,'external.png');await writeFile(file,png);
    const media=new MediaService(join(root,'media'),()=>DEFAULT_SETTINGS.social);
    assert.equal(new OneBotHttp('http://127.0.0.1:3000','').hasLocalMedia,true);
    assert.equal(new OneBotHttp('http://localhost:3000','').hasLocalMedia,true);
    assert.equal(new OneBotHttp('http://[::1]:3000','').hasLocalMedia,true);
    assert.equal(new OneBotHttp('http://192.168.1.20:3000','').hasLocalMedia,false);
    assert.equal(new OneBotHttp('https://example.com','').hasLocalMedia,false);
    assert.equal(new OneBotHttp('http://127.example.com','').hasLocalMedia,false);
    const imported=await media.onebotImage({file},signal(),true);assert.equal(imported.mimeType,'image/png');
    await assert.rejects(media.onebotImage({file},signal(),false),/媒体库/);
    await assert.rejects(media.bytes(file,signal()),/媒体库/);
    const remote=await media.onebotImage({base64:png.toString('base64')},signal(),false);assert.equal(remote.data,imported.data);
    await assert.rejects(media.onebotImage({base64:'!invalid!'},signal(),false),/图片数据/);
    await assert.rejects(media.onebotImage(null,signal(),true),/图片信息/);
    await assert.rejects(media.onebotImage({base64:'a'.repeat(16_000_004)},signal(),false),/过大/);
    const invalid=join(root,'secret.txt');await writeFile(invalid,'not an image');await assert.rejects(media.onebotImage({file:invalid},signal(),true),/不是受支持/);
    const tooLarge=join(root,'large.png');await writeFile(tooLarge,Buffer.alloc(12_000_001));await assert.rejects(media.onebotImage({file:tooLarge},signal(),true),/过大/);
    const uri=await media.onebotImage({file:pathToFileURL(file).href},signal(),true);assert.equal(uri.data,imported.data);
    for(const address of ['http://127.0.0.1/private','http://192.168.1.1/private','http://198.18.0.115/fake'])await assert.rejects(downloadPublic(address,signal()),/内网/);
  } finally {await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
