import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {readSocialData} from './helpers/social-data.mjs';
import {withTimeout} from '../dist/core/runtime.js';

test('真实桥接绑定本轮身份：HTTP 重复只发送一次，换正文和自报编号拒绝，未知结果不重发', {timeout:25000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-operation-bridge-')),calls=[];let child,output='',next=100;
  const http=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const args=JSON.parse(raw||'{}');let data={};
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'测试'};
    if(req.url==='/get_friend_list')data=[{user_id:20001,nickname:'测试好友'}];if(req.url==='/get_group_list')data=[];
    if(req.url==='/send_private_msg'){calls.push(args);if(args.message==='丢失响应'){res.destroy();return;}data={message_id:next++};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));});http.listen(0,'127.0.0.1');await once(http,'listening');
  const ws=new WebSocketServer({port:0,host:'127.0.0.1'});if(!ws.address())await once(ws,'listening');
  const events=join(root,'events.jsonl'),social=join(root,'social.json');
  const until=async check=>{const end=Date.now()+8000;while(!await check()){if(Date.now()>end)throw new Error('等待事务桥接超时\n'+output);await new Promise(done=>setTimeout(done,25));}};
  try{
    const wrapper=join(root,process.platform==='win32'?'dsh.cmd':'fixture-dsh'),script=resolve('tests/fixtures/fake-dsh.mjs');await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}"\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,{mode:0o700});
    await writeFile(join(root,'settings.json'),JSON.stringify({chat:{delay:{minMs:0,maxMs:0}},social:{autonomy:'autonomous',actionsPerMinute:100}}));const connected=once(ws,'connection');
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{env:{...process.env,BOT_DSH_BIN:wrapper,BOT_WORKSPACE:root,ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,SESSION_STORE:join(root,'sessions.json'),BOT_SOCIAL_STORE:social,BOT_SETTINGS_FILE:join(root,'settings.json'),BOT_SELF_ID:'10000',FAKE_OPERATION_EVENTS:events,TURN_TIMEOUT_MS:'6000'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
    const [socket]=await withTimeout(connected,10000),readEvents=async()=>{try{return (await readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
    for(let id=1;id<=2;id++){
      socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:10000,user_id:20001,message_id:id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'OPERATION_REPLAY'}}],sender:{user_id:20001,nickname:'测试好友'}}));
      await until(async()=>(await readEvents()).length>=id);await until(async()=>(await readSocialData(social)).turns.length>=id);
    }
    assert.equal(calls.filter(row=>row.message==='逻辑动作只发一次').length,2);assert.equal(calls.filter(row=>row.message==='丢失响应').length,2);assert.equal(calls.length,4);
    for(const event of await readEvents()){assert.ok(event.joined.every(row=>row.status===200));assert.equal(new Set(event.joined.map(row=>row.body.data.message_id)).size,1);assert.equal(event.changed.status,409);assert.equal(event.invalid.status,400);assert.equal(event.forged.status,400);assert.equal(event.firstLost.status,409);assert.equal(event.secondLost.status,409);}
    const data=await readSocialData(social);assert.equal(data.actions.filter(row=>row.state==='success').length,2);assert.equal(data.actions.filter(row=>row.state==='unknown').length,2);
  }finally{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}for(const socket of ws.clients)socket.terminate();await new Promise(done=>ws.close(done));http.closeAllConnections();await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
