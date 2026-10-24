import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('ACP + 真实 QQ MCP：工具回复不重复，潜水不兜底，记忆、用量与 QQ 事件持久化', {timeout:20000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'qq-social-e2e-'));
  let child,output='',next=100;
  const sent=[];
  const http=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const args=JSON.parse(raw||'{}');let data={};
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'小鲸'};
    if(req.url==='/send_group_msg'||req.url==='/send_private_msg'){data={message_id:next++};sent.push(args);}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });http.listen(0,'127.0.0.1');await once(http,'listening');
  const ws=new WebSocketServer({port:0,host:'127.0.0.1'});if(!ws.address())await once(ws,'listening');
  const until=async check=>{const end=Date.now()+7000;while(!await check()){if(Date.now()>end)throw new Error('等待超时\n'+output);await new Promise(r=>setTimeout(r,25));}};
  try {
    const wrapper=join(dir,process.platform==='win32'?'agent.cmd':'agent');
    const script=resolve('tests/fixtures/fake-dsh.mjs');
    await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}"\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,{mode:0o700});
    await writeFile(join(dir,'settings.json'),JSON.stringify({chat:{delay:{minMs:0,maxMs:0}},social:{autonomy:'autonomous'}}));
    const connected=once(ws,'connection');
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{env:{...process.env,BOT_DSH_BIN:wrapper,BOT_WORKSPACE:dir,ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,SESSION_STORE:join(dir,'sessions.json'),BOT_SETTINGS_FILE:join(dir,'settings.json'),BOT_SOCIAL_STORE:join(dir,'social.json'),BOT_SELF_ID:'10000',TURN_TIMEOUT_MS:'5000'},stdio:['ignore','pipe','pipe']});
    for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
    const[socket]=await connected;
    const send=(id,text,user=20001)=>socket.send(JSON.stringify({post_type:'message',message_type:'group',self_id:10000,time:Math.floor(Date.now()/1000),group_id:30001,user_id:user,message_id:id,message:[{type:'at',data:{qq:'10000'}},{type:'text',data:{text}}],sender:{user_id:user,nickname:'测试群友'}}));
    send(-1,'SOCIAL_REPLY');await until(()=>sent.length===1);
    assert.equal(sent[0].message[0].type,'reply');assert.equal(sent[0].message[0].data.id,'-1');
    send(-2,'SOCIAL_SILENT');
    const data=async()=>JSON.parse(await readFile(join(dir,'social.json'),'utf8'));
    await until(async()=> (await data()).turns.length>=2);assert.equal(sent.length,1);
    send(-3,'SOCIAL_MEMORY');await until(()=>sent.length===2);assert.equal(sent[1].message,'记住了');
    socket.send(JSON.stringify({post_type:'notice',notice_type:'group_recall',self_id:10000,group_id:30001,user_id:20001,message_id:-1,time:Math.floor(Date.now()/1000)}));
    await until(async()=> (await data()).events.length===1);
    const stored=await data();assert.equal(stored.memories[0].text,'喜欢咖啡');assert.equal(stored.turns[0].inputTokens,120);assert.equal(stored.messages.find(m=>m.id===-1).recalled,true);
    assert.ok(!sent.some(s=>JSON.stringify(s.message).includes('重复文本')));
  } finally {
    if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
    for(const socket of ws.clients)socket.terminate();await new Promise(r=>ws.close(r));await new Promise(r=>http.close(r));
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
