import {readSocialData} from './helpers/social-data.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { withTimeout } from '../dist/core/runtime.js';
import { SocialStore } from '../dist/qq/social-store.js';

test('聚合保留全部消息、会话继承全局概率、屏蔽引用过滤、停止延迟与最后轮次落盘', {timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-batch-audit-')),sent=[];
  let child,socket,output='',next=100;
  const http=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw||'{}');let data={};
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'小鲸'};
    if(req.url==='/send_group_msg'||req.url==='/send_private_msg'){sent.push(input);data={message_id:next++};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });http.listen(0,'127.0.0.1');await once(http,'listening');
  const ws=new WebSocketServer({port:0,host:'127.0.0.1'});if(!ws.address())await once(ws,'listening');
  const wrapper=join(dir,process.platform==='win32'?'fake.cmd':'fake-dsh'),fixture=resolve('tests/fixtures/fake-dsh.mjs');
  await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${fixture}"\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`,{mode:0o700});
  const settingsPath=join(dir,'settings.json'),promptsPath=join(dir,'prompts.jsonl');
  const settings={social:{batchWindowMs:150,responseMode:'probability',responseProbability:100},chat:{group:{contextLines:0,cooldownMs:0},delay:{minMs:0,maxMs:0,chunkSize:4000}}};
  const prepared=new SocialStore(join(dir,'social.json'));await prepared.load();await prepared.update(d=>d.profiles.push({chat:'group:30001',persona:'会话测试人设',responseMode:'inherit',probability:0,keywords:[],proactive:true}));
  const until=async(fn)=>{const limit=Date.now()+7000;while(Date.now()<limit){if(await fn())return;await new Promise(r=>setTimeout(r,15));}throw new Error('等待审计链路超时\n'+output);};
  const prompts=async()=>readFile(promptsPath,'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(JSON.parse),()=>[]);
  const start=async()=>{
    await writeFile(settingsPath,JSON.stringify(settings));const connection=once(ws,'connection');
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{
      ...process.env,BOT_CHAT_MODE:'profile',BOT_DSH_BIN:wrapper,BOT_WORKSPACE:dir,BOT_SETTINGS_FILE:settingsPath,
      SESSION_STORE:join(dir,'sessions.json'),BOT_SOCIAL_STORE:join(dir,'social.json'),BOT_USAGE_STORE:join(dir,'usage.json'),BOT_GROUP_CONTEXT_STORE:join(dir,'context.json'),
      ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,ONEBOT_TOKEN:'',ADMIN_QQ:'0',TURN_TIMEOUT_MS:'3000',FAKE_GROUP_PROMPTS:promptsPath,
    }});child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);[socket]=await withTimeout(connection,7000);
  };
  const stop=async()=>{if(!child||child.exitCode!==null)return;const ended=once(child,'exit');child.send('shutdown');const [code]=await withTimeout(ended,7000);assert.equal(code,0,output);};
  const send=(text,user=20001,group,quote,mention=true)=>{
    const id=next++;socket.send(JSON.stringify({post_type:'message',message_type:group?'group':'private',self_id:10000,user_id:user,message_id:id,time:Math.floor(Date.now()/1000),
      ...(group?{group_id:group}:{}),message:group?[...(mention?[{type:'at',data:{qq:'10000'}}]:[]),...(quote?[{type:'reply',data:{id:String(quote)}}]:[]),{type:'text',data:{text}}]:text,sender:{nickname:'甲'+user}}));return id;
  };
  try {
    await start();const ids=[send('私聊前半句'),send('私聊后半句')];send('另一个私聊',20002);
    await until(()=>sent.length===2);let seen=await prompts();assert.equal(seen.length,2);
    const first=seen.find(p=>p.text.includes('私聊前半句'));assert.ok(first);assert.match(first.text,/私聊后半句/);
    for(const id of ids)assert.ok(first.text.includes('#'+id));
    assert.doesNotMatch(first.text,/另一个私聊/);assert.equal(sent.filter(s=>s.user_id===20001).length,1);
    const groupIds=[send('群聊前半句',20001,30001),send('群聊后半句',20002,30001)];
    await until(()=>sent.length===3);seen=await prompts();const group=seen.find(p=>p.text.includes('群聊前半句'));
    assert.ok(group);assert.match(group.text,/群聊后半句/);for(const id of groupIds)assert.ok(group.text.includes('#'+id));
    send('继承全局百分之百概率',20003,30001,undefined,false);await until(()=>sent.length===4);
    await stop();assert.equal((await readSocialData(join(dir,'social.json'))).turns.length,4);
    settings.social.blockedUsers=['20001'];await start();send('引用已屏蔽者',20002,30001,groupIds[0]);
    await until(()=>sent.length===5);assert.doesNotMatch((await prompts()).at(-1).text,/群聊前半句/);await stop();
    settings.social.blockedUsers=[];settings.chat.delay.minMs=10000;settings.chat.delay.maxMs=10000;output='';await start();send('延迟中停止');
    await until(()=>output.includes('[msg] private:20001 ->'));
    const started=Date.now();await stop();assert.ok(Date.now()-started<5000,'停止不应等待十秒回复延迟');
    assert.equal(sent.length,5,'退出后不可继续发送');
    const persisted=await readSocialData(join(dir,'social.json'));assert.equal(persisted.turns.length,6);assert.ok(persisted.turns.some(t=>t.input.includes('延迟中停止')));
  } finally {
    if(child&&child.exitCode===null){child.send('shutdown');await withTimeout(once(child,'exit'),7000).catch(()=>child.kill());}
    for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));http.closeAllConnections();await new Promise(done=>http.close(done));
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
