import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WebSocketServer} from 'ws';
import {withTimeout} from '../dist/core/runtime.js';
import {readSessionMappings} from './helpers/runtime-data.mjs';

test('五个会话受四个活跃名额限制，远端关闭后保留磁盘映射并按需恢复',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-session-cache-bridge-')),sent=[],lifecycle=join(root,'lifecycle.jsonl');let child,output='',id=1;
  const http=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw||'{}');let data={};
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'fixture'};if(req.url==='/get_friend_list')data=Array.from({length:5},(_,i)=>({user_id:20001+i,nickname:'fixture'}));if(req.url==='/get_group_list')data=[];
    if(req.url==='/send_private_msg'){sent.push(input);data={message_id:id++};}res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });const ws=new WebSocketServer({host:'127.0.0.1',port:0}),connected=once(ws,'connection');http.listen(0,'127.0.0.1');await once(http,'listening');if(!ws.address())await once(ws,'listening');
  const until=async predicate=>{const start=Date.now();while(Date.now()-start<8000){if(await predicate())return;await new Promise(done=>setTimeout(done,15));}throw new Error('session cache bridge timeout\n'+output);};
  try{
    const settings=join(root,'settings.json');await writeFile(settings,JSON.stringify({context:{activeSessions:4,idleMinutes:1},chat:{delay:{minMs:0,maxMs:0,chunkSize:4000}}}));const fake=resolve('tests/fixtures/fake-dsh.mjs'),wrapper=join(root,process.platform==='win32'?'dsh.cmd':'dsh');await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o700});
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BOT_DSH_BIN:wrapper,BOT_DSH_PROFILE:'acp',BOT_CHAT_MODE:'profile',BOT_WORKSPACE:root,BOT_SETTINGS_FILE:settings,SESSION_STORE:join(root,'sessions.json'),BOT_USAGE_STORE:join(root,'usage.json'),BOT_SOCIAL_STORE:join(root,'social.json'),BOT_GROUP_CONTEXT_STORE:join(root,'context.json'),BOT_MEDIA_DIR:join(root,'media'),ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,ONEBOT_TOKEN:'',BOT_SELF_ID:'10000',FAKE_LIFECYCLE_EVENTS:lifecycle}});child.stdout.on('data',part=>{output+=part;});child.stderr.on('data',part=>{output+=part;});const [socket]=await withTimeout(connected,10000);await until(()=>output.includes('[bridge] ready'));
    const send=user=>socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:10000,time:0,user_id:user,message_id:id++,raw_message:'缓存测试',message:[{type:'text',data:{text:'缓存测试'}}],sender:{user_id:user,nickname:'fixture'}}));
    for(let user=20001;user<=20005;user++){send(user);await until(()=>sent.some(reply=>reply.user_id===user));}
    const mappings=readSessionMappings(join(root,'sessions.json')).sessions;assert.equal(Object.keys(mappings).length,5);const original=mappings['private:20001'].sessionId;send(20001);await until(()=>sent.filter(reply=>reply.user_id===20001).length===2);
    const events=(await readFile(lifecycle,'utf8')).trim().split('\n').map(JSON.parse),active=new Set();let peak=0;for(const event of events){if(event.kind==='close')active.delete(event.sessionId);else active.add(event.sessionId);peak=Math.max(peak,active.size);}
    assert.equal(events.filter(event=>event.kind==='new').length,5);assert.equal(events.filter(event=>event.kind==='close').length,2);assert.equal(events.filter(event=>event.kind==='resume'&&event.sessionId===original).length,1);assert.equal(peak,4);assert.equal(active.size,4);assert.equal(readSessionMappings(join(root,'sessions.json')).sessions['private:20001'].sessionId,original);assert.doesNotMatch(output,/Invalid params|unhandled|会话已满/i);
  }finally{if(child&&child.exitCode===null){child.kill();await withTimeout(once(child,'exit'),5000).catch(()=>{});}for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
