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

test('桥接总预算耗尽不进入模型，失败提示仍受联系范围约束，QQ 动作耗尽后不再调用模型',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-bridge-request-budget-')),replies=[],prompts=join(root,'prompts.jsonl');let child,output='',sequence=1;
  let notified;const response=new Promise(done=>{notified=done;});
  const http=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw||'{}');let data={};
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'fixture'};
    if(req.url==='/get_friend_list')data=[{user_id:20001,nickname:'allowed'},{user_id:20002,nickname:'blocked'}];
    if(req.url==='/get_group_list')data=[];
    if(req.url==='/send_private_msg'){replies.push(input);data={message_id:sequence++};notified();}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });
  const ws=new WebSocketServer({host:'127.0.0.1',port:0}),connected=once(ws,'connection');http.listen(0,'127.0.0.1');await once(http,'listening');if(!ws.address())await once(ws,'listening');
  const settingsPath=join(root,'settings.json'),settings={social:{allowAll:false,allowedUsers:['20001'],actionsPerDay:1},requests:{perDay:0},chat:{delay:{minMs:0,maxMs:0}}};
  try{
    await writeFile(settingsPath,JSON.stringify(settings));const wrapper=join(root,process.platform==='win32'?'dsh.cmd':'dsh'),fake=resolve('tests/fixtures/fake-dsh.mjs');
    await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o700});
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,ONEBOT_TOKEN:'fixture-private-token',BOT_SELF_ID:'10000',BOT_DSH_BIN:wrapper,BOT_DSH_PROFILE:'acp',BOT_CHAT_MODE:'profile',BOT_WORKSPACE:root,BOT_SETTINGS_FILE:settingsPath,SESSION_STORE:join(root,'sessions.json'),BOT_USAGE_STORE:join(root,'usage.json'),BOT_SOCIAL_STORE:join(root,'social.json'),BOT_GROUP_CONTEXT_STORE:join(root,'context.json'),FAKE_GROUP_PROMPTS:prompts,BOT_ACTION_TOKEN:'',BOT_ACTION_URL:''}});
    child.stdout.on('data',part=>{output+=part;});child.stderr.on('data',part=>{output+=part;});const [socket]=await withTimeout(connected,10000);
    const send=(user,text)=>socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:10000,time:0,user_id:user,message_id:sequence++,raw_message:text,message:[{type:'text',data:{text}}],sender:{user_id:user,nickname:'fixture'}}));
    send(20002,'blocked request');send(20001,'allowed request');await withTimeout(response,8000);
    assert.equal(replies.length,1);assert.equal(replies[0].user_id,20001);assert.match(replies[0].message,/模型请求已达到运行上限/);assert.equal(await readFile(prompts,'utf8').catch(()=>''),'');
    // The permitted failure message used the single QQ action. Opening model
    // requests must not dispatch another model turn when no reply can be sent.
    settings.requests.perDay=10;await writeFile(settingsPath,JSON.stringify(settings));await new Promise(done=>setTimeout(done,650));send(20001,'action limit request');
    await withTimeout(new Promise((done,reject)=>{const started=Date.now(),timer=setInterval(()=>{if(output.includes('今日 QQ 动作额度已用完')){clearInterval(timer);done();}else if(Date.now()-started>6000){clearInterval(timer);reject(new Error('missing action quota rejection'));}},25);}),7000);
    assert.equal(replies.length,1);assert.equal(await readFile(prompts,'utf8').catch(()=>''),'');assert.doesNotMatch(output,/fixture-private-token/);
  }catch(error){error.message+='\n'+output;throw error;}
  finally{if(child&&child.exitCode===null){child.kill();await withTimeout(once(child,'exit'),5000).catch(()=>{});}for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
