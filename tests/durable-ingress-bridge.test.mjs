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

test('桥接重启后上游重放同一消息不再调用模型或回复，新消息仍可继续',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-durable-ingress-')),sent=[],prompts=join(root,'prompts.jsonl');let child,socket,output='',replyId=1000;
  const http=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw||'{}');let data={};if(req.url==='/get_login_info')data={user_id:10000,nickname:'fixture'};if(req.url==='/get_friend_list')data=[{user_id:20001,nickname:'fixture'}];if(req.url==='/get_group_list')data=[];if(req.url==='/send_private_msg'){sent.push(input);data={message_id:replyId++};}res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));});
  const ws=new WebSocketServer({host:'127.0.0.1',port:0});http.listen(0,'127.0.0.1');await once(http,'listening');if(!ws.address())await once(ws,'listening');
  const wait=async predicate=>{const start=Date.now();while(Date.now()-start<8000){if(await predicate())return;await new Promise(done=>setTimeout(done,15));}throw new Error('durable ingress timeout\n'+output);};
  const stop=async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.send('shutdown');assert.equal((await withTimeout(exited,6000))[0],0,output);}};
  try{
    const fake=resolve('tests/fixtures/fake-dsh.mjs'),wrapper=join(root,process.platform==='win32'?'dsh.cmd':'dsh'),settings=join(root,'settings.json');await writeFile(settings,JSON.stringify({chat:{delay:{minMs:0,maxMs:0,chunkSize:4000}}}));await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o700});
    const start=async()=>{output='';const connected=once(ws,'connection');child=spawn(process.execPath,[resolve('dist/bridge.js')],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,BOT_DSH_BIN:wrapper,BOT_DSH_PROFILE:'acp',BOT_CHAT_MODE:'profile',BOT_WORKSPACE:root,BOT_SETTINGS_FILE:settings,SESSION_STORE:join(root,'sessions.json'),BOT_USAGE_STORE:join(root,'usage.json'),BOT_SOCIAL_STORE:join(root,'social.json'),BOT_GROUP_CONTEXT_STORE:join(root,'context.json'),BOT_MEDIA_DIR:join(root,'media'),ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,ONEBOT_TOKEN:'',BOT_SELF_ID:'10000',FAKE_GROUP_PROMPTS:prompts}});child.stdout.on('data',part=>{output+=part;});child.stderr.on('data',part=>{output+=part;});[socket]=await withTimeout(connected,10000);await wait(()=>output.includes('[bridge] ready'));};
    const first={post_type:'message',message_type:'private',self_id:10000,time:Math.floor(Date.now()/1000),user_id:20001,message_id:10,message:[{type:'text',data:{text:'第一条真实来信'}}],sender:{user_id:20001,nickname:'fixture'}};
    await start();socket.send(JSON.stringify(first));await wait(()=>sent.length===1);await stop();await start();socket.send(JSON.stringify(first));socket.send(JSON.stringify({...first,message_id:12,time:first.time-32*86400,message:[{type:'text',data:{text:'过期历史帧'}}]}));socket.send(JSON.stringify({...first,message_id:11,message:[{type:'text',data:{text:'新的来信'}}]}));await wait(()=>sent.length===2);await stop();assert.match(output,/历史消息已超过自动处理保留期/);
    const calls=(await readFile(prompts,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);assert.match(calls[0].text,/第一条真实来信/);assert.match(calls[1].text,/新的来信/);assert.equal(sent.length,2);
  }finally{if(child&&child.exitCode===null){child.kill();await withTimeout(once(child,'exit'),5000).catch(()=>{});}for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
