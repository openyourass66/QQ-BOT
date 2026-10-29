import {readSocialData} from './helpers/social-data.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fakeQqFavorites } from './helpers/sticker-review.mjs';

test('完整后台链路：真实 ACP/MCP 保存想法、主动聊天、安静收藏、独立空间且不泄露私聊', {timeout:25000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-autonomy-e2e-')),favorites=fakeQqFavorites(),sent=[],posts=[];
  let child,output='',now=Date.now(),next=100;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const args=JSON.parse(raw||'{}');let data={};
    const favorite=await favorites.protocol(req.url.slice(1),args);
    if(favorite.matched)data=favorite.data;
    else if(['/send_private_msg','/send_group_msg'].includes(req.url)){sent.push(args);data={message_id:next++};}
    else if(req.url==='/send_qzone_msg'){posts.push(args);data={tid:'qzone-'+next++};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const ws=new WebSocketServer({port:0,host:'127.0.0.1'});if(!ws.address())await once(ws,'listening');
  const until=async check=>{const end=Date.now()+8000;while(!await check()){if(Date.now()>end)throw new Error('等待自主链路超时\n'+output);await new Promise(r=>setTimeout(r,25));}};
  try {
    await mkdir(join(dir,'media'));const image=join(dir,'media/received.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64'));
    const clock=join(dir,'clock'),events=join(dir,'events.jsonl');await writeFile(clock,String(now));
    await writeFile(join(dir,'social.json'),JSON.stringify({version:1,account:10000,messages:[],contacts:[],memories:[],stickers:[],tasks:[],events:[],actions:[],turns:[],profiles:[],autonomous:{lastScanAt:now}}));
    await writeFile(join(dir,'settings.json'),JSON.stringify({chat:{delay:{minMs:0,maxMs:0}},features:{qzone:{enabled:true,requireConfirm:false,dailyLimit:5}},social:{proactiveEnabled:true,proactiveIntervalMinutes:5,quietStartHour:0,quietEndHour:0,autoCollectStickers:true,autoQzoneEnabled:true}}));
    const wrapper=join(dir,process.platform==='win32'?'agent.cmd':'agent'),script=resolve('tests/fixtures/fake-dsh.mjs');
    await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}"\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,{mode:0o700});
    const connected=once(ws,'connection');
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{env:{...process.env,BOT_DSH_BIN:wrapper,BOT_WORKSPACE:dir,ONEBOT_HTTP_URL:`http://127.0.0.1:${server.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,SESSION_STORE:join(dir,'sessions.json'),BOT_SOCIAL_STORE:join(dir,'social.json'),BOT_SETTINGS_FILE:join(dir,'settings.json'),BOT_SELF_ID:'10000',TURN_TIMEOUT_MS:'5000',FAKE_AUTONOMY_CLOCK:clock,FAKE_AUTONOMY_EVENTS:events,NODE_OPTIONS:`--import=${pathToFileURL(resolve('tests/fixtures/autonomy-clock.mjs')).href}`},stdio:['ignore','pipe','pipe']});
    for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
    const [socket]=await connected;
    socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:10000,user_id:20001,time:Math.floor(now/1000),message_id:1,message:[{type:'text',data:{text:'AUTONOMY_SEED SECRET_AUTONOMY：只在私聊说的事'}},{type:'image',data:{file:image}}],sender:{user_id:20001,nickname:'测试朋友'}}));
    const data=async()=>await readSocialData(join(dir,'social.json'));
    await until(async()=>(await data()).turns.length>=1);assert.equal(sent.length,0);
    now+=6*60000;await writeFile(clock,String(now));await until(async()=>(await data()).autonomous.decisions.length>=1);
    assert.equal(sent.length,1);assert.equal(sent[0].message,'昨天说的猫猫表情找到了吗？');
    now+=6*60000;await writeFile(clock,String(now));await until(async()=>(await data()).autonomous.decisions.length>=2);
    assert.equal(favorites.items.length,1);assert.equal(sent.length,1);
    now+=6*60000;await writeFile(clock,String(now));await until(async()=>(await data()).autonomous.decisions.length>=3);
    assert.equal(posts.length,1);assert.doesNotMatch(posts[0].content,/SECRET_AUTONOMY/);assert.equal(sent.length,1);
    const stored=await data();assert.ok(stored.turns.some(t=>t.chat==='self:qzone'));assert.equal(stored.autonomous.posts[0].state,'success');
    const publicPrompt=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse).find(e=>e.public);
    assert.ok(publicPrompt);assert.doesNotMatch(publicPrompt.prompt,/SECRET_AUTONOMY/);
    assert.ok(stored.autonomous.decisions.every(d=>d.outcome==='done'));
  } finally {
    if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
    for(const socket of ws.clients)socket.terminate();await new Promise(r=>ws.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
