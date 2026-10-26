import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('没有新消息和用户指令时，真实后台链路自行触发语音、空间创作与好友评论',{timeout:25000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-autonomy-no-input-')),sent=[],posts=[];let child,output='',now=Date.now();
  const http=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const args=JSON.parse(raw||'{}');let data={};
    if(req.url==='/audio/speech'){res.setHeader('content-type','audio/mpeg');res.end(Buffer.from('fixture-mp3'));return;}
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'测试'};
    if(req.url==='/get_friend_list')data=[{user_id:20001,nickname:'测试朋友'}];
    if(req.url==='/get_group_list')data=[];
    if(req.url==='/get_cookies')data={cookies:'uin=o10000; p_uin=o10000; p_skey=fixture-space-key'};
    if(req.url==='/send_private_msg'){sent.push(args);data={message_id:100+sent.length};}
    if(req.url==='/send_qzone_msg'){posts.push(args);data={tid:'space-created'};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });http.listen(0,'127.0.0.1');await once(http,'listening');
  const ws=new WebSocketServer({port:0,host:'127.0.0.1'});if(!ws.address())await once(ws,'listening');
  const clock=join(root,'clock'),events=join(root,'events.jsonl'),comments=join(root,'comments.jsonl');
  const until=async predicate=>{const end=Date.now()+9000;while(!await predicate()){if(Date.now()>end)throw new Error('自主触发等待超时：'+output.slice(-1000));await new Promise(done=>setTimeout(done,25));}};
  const data=async()=>JSON.parse(await readFile(join(root,'social.json'),'utf8'));
  try{
    await writeFile(clock,String(now));await writeFile(comments,'');
    const at=now-3*3600000;
    await writeFile(join(root,'social.json'),JSON.stringify({version:2,account:10000,messages:[{chat:'private:20001',id:1,user:20001,name:'朋友',at,text:'SECRET_AUTONOMY 之前一起聊过猫猫',segments:[],self:false,recalled:false}],contacts:[{chat:'private:20001',name:'朋友',at}],memories:[],stickers:[],tasks:[],events:[],actions:[],turns:[],autonomous:{lastScanAt:0}}));
    await writeFile(join(root,'settings.json'),JSON.stringify({chat:{delay:{minMs:0,maxMs:0}},features:{qzone:{enabled:true,requireConfirm:false,dailyLimit:5,browseEnabled:true,commentsEnabled:true,commentRequireConfirm:false}},social:{proactiveEnabled:true,proactiveIntervalMinutes:5,quietStartHour:0,quietEndHour:0,autoQzoneEnabled:true,autoQzoneCommentEnabled:true,qzoneCommentIntervalMinutes:5,autoCollectStickers:false,speechModel:'fixture-tts'}}));
    const script=resolve('tests/fixtures/fake-dsh.mjs'),wrapper=join(root,process.platform==='win32'?'agent.cmd':'agent');
    await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}"\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,{mode:0o700});
    const connected=once(ws,'connection');
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{env:{...process.env,BOT_CHAT_MODE:'profile',BOT_DSH_BIN:wrapper,BOT_WORKSPACE:root,BOT_SETTINGS_FILE:join(root,'settings.json'),BOT_SELF_ID:'10000',SESSION_STORE:join(root,'sessions.json'),BOT_SOCIAL_STORE:join(root,'social.json'),BOT_MEDIA_DIR:join(root,'media'),BOT_USAGE_STORE:join(root,'usage.json'),BOT_GROUP_CONTEXT_STORE:join(root,'context.json'),ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,BOT_MEDIA_BASE_URL:`http://127.0.0.1:${http.address().port}/`,FAKE_AUTONOMY_NO_INSTRUCTION:'1',FAKE_AUTONOMY_CLOCK:clock,FAKE_AUTONOMY_EVENTS:events,FAKE_QZONE_POSTS:comments,TURN_TIMEOUT_MS:'5000',NODE_OPTIONS:`--import=${pathToFileURL(resolve('tests/fixtures/autonomy-clock.mjs')).href} --import=${pathToFileURL(resolve('tests/fixtures/autonomy-qzone.mjs')).href}`},windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});await connected;
    await until(async()=>(await data()).autonomous.decisions.length>=1);assert.equal(sent.length,1);assert.equal(sent[0].message[0].type,'record');
    now+=31000;await writeFile(clock,String(now));await until(async()=>(await data()).autonomous.decisions.length>=2);assert.equal(posts.length,1);assert.doesNotMatch(posts[0].content,/SECRET_AUTONOMY/);
    now+=31000;await writeFile(clock,String(now));await until(async()=>(await data()).autonomous.decisions.length>=3);
    const submissions=(await readFile(comments,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(submissions.length,1);assert.equal(submissions[0].owner,'20001');assert.equal(sent.length,1);
    const prompts=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(prompts.map(event=>event.kind),['chat','qzone','qzone-comment']);
    assert.ok(prompts.filter(event=>event.kind!=='chat').every(event=>!event.prompt.includes('SECRET_AUTONOMY')));assert.ok((await data()).autonomous.decisions.every(item=>item.outcome==='done'));
  }finally{
    if(child&&child.exitCode===null){child.kill();await once(child,'exit');}for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));http.closeAllConnections();await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
