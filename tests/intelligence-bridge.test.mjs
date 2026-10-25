import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_SETTINGS } from '../dist/settings.js';

async function scenario(fail,learning=false,changePolicy=false) {
  const root=await mkdtemp(join(tmpdir(),'qq-intelligence-bridge-')),replies=[],analysisRequests=[];let child,output='',message=100;
  const http=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;let data={};
    if(req.url==='/search'){res.setHeader('content-type','application/json');res.end(JSON.stringify({results:[{title:'Fixture source',url:'https://example.test/source',snippet:'Fixture snippet'}]}));return;}
    if(req.url==='/v1/messages'){analysisRequests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({content:[{type:'text',text:JSON.stringify({memories:[{user:'20001',text:'喜欢喝黑咖啡',evidence:[{messageId:11,quote:'我一直喜欢喝黑咖啡'}]}],lexicon:[]})}],usage:{input_tokens:123,output_tokens:45}}));return;}
    if(req.url==='/get_login_info')data={user_id:10000,nickname:'测试'};
    if(req.url==='/get_group_list')data=[{group_id:30001,group_name:'测试群'}];
    if(req.url==='/get_friend_list')data=[{user_id:20001,nickname:'甲'}];
    if(req.url==='/send_group_msg'){replies.push(JSON.parse(raw));data={message_id:message++};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');const ws=new WebSocketServer({port:0,host:'127.0.0.1'});if(!ws.address())await once(ws,'listening');
  const connected=once(ws,'connection'),settings=structuredClone(DEFAULT_SETTINGS),events=join(root,'events.jsonl');
  settings.context.filterTools=true;settings.context.rollover=true;settings.social.filesEnabled=false;settings.social.mediaEnabled=false;settings.chat.delay.minMs=0;settings.chat.delay.maxMs=0;
  if(changePolicy)settings.context.rollover=false;
  if(learning){Object.assign(settings.learning,{memory:true,chats:['group:30001'],minMessages:3,idleMinutes:1});await writeFile(join(root,'social.json'),JSON.stringify({version:1,account:10000,messages:[11,12,13].map(id=>({id,chat:'group:30001',user:20001,name:'甲',at:Date.now()-600000+id,text:id===11?'我一直喜欢喝黑咖啡':'这是普通聊天文字 '+id,segments:[{type:'text',data:{text:'文字'}}],self:false,recalled:false})),contacts:[],memories:[],stickers:[],tasks:[],events:[],actions:[],turns:[]}));}
  const settingsPath=join(root,'settings.json');await writeFile(settingsPath,JSON.stringify(settings));await writeFile(join(root,'AGENTS.md'),'测试人设');
  const wrapper=join(root,process.platform==='win32'?'intelligence dsh.cmd':'intelligence-dsh'),fake=resolve('tests/fixtures/intelligence-dsh.mjs');
  await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o700});
  const wait=async predicate=>{const until=Date.now()+10000;while(Date.now()<until){if(await predicate())return;await new Promise(done=>setTimeout(done,40));}throw new Error('fixture timeout: '+output.slice(-1400));};
  const data=async name=>JSON.parse(await readFile(join(root,name),'utf8'));
  try{
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{env:{...process.env,BOT_CHAT_MODE:'profile',BOT_DSH_BIN:wrapper,BOT_DSH_PROFILE:'acp',BOT_WORKSPACE:root,BOT_SETTINGS_FILE:settingsPath,
      ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_WS_URL:`ws://127.0.0.1:${ws.address().port}`,
      SESSION_STORE:join(root,'sessions.json'),BOT_SOCIAL_STORE:join(root,'social.json'),BOT_USAGE_STORE:join(root,'usage.json'),BOT_GROUP_CONTEXT_STORE:join(root,'context.json'),BOT_MEDIA_DIR:join(root,'media'),INTELLIGENCE_EVENTS:events,INTELLIGENCE_FAIL_SECOND:fail?'1':'0',
      INTELLIGENCE_TEST_TOOLS:'1',BOT_SEARCH_URL:`http://127.0.0.1:${http.address().port}/search`,BOT_LEARNING_API_KEY:'fixture-analysis-key',BOT_LEARNING_BASE_URL:`http://127.0.0.1:${http.address().port}`,BOT_LEARNING_MODEL:'fixture-analysis'},stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
    const [socket]=await Promise.race([connected,new Promise((_,reject)=>setTimeout(()=>reject(new Error('connection timeout '+output)),10000).unref())]);
    await wait(()=>output.includes('[bridge] ready'));
    if(learning)await wait(async()=>{try{return (await data('social.json')).cognition.jobs.some(j=>j.state==='completed');}catch{return false;}});
    const send=id=>socket.send(JSON.stringify({post_type:'message',message_type:'group',self_id:10000,user_id:20001,group_id:30001,message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'甲'},message:[{type:'at',data:{qq:'10000'}},{type:'text',data:{text:'测试问题 '+id}}]}));
    send(1);await wait(()=>replies.length===1);
    let social=await data('social.json');assert.equal(social.turns[0].contextUsed,90);assert.equal(social.turns[0].contextSize,100);assert.equal(social.turns[0].inputTokens,null);
    const original=(await data('sessions.json')).sessions['group:30001'].sessionId;
    const firstEvents=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse),manifest=JSON.parse(firstEvents.find(e=>e.kind==='new').servers[0].env.find(e=>e.name==='BOT_QQ_TOOLS').value);
    assert.ok(manifest.includes('qq_web_read'));assert.ok(!manifest.includes('qq_send_file'));assert.ok(!manifest.includes('qq_transcribe'));
    const tools=firstEvents.find(e=>e.kind==='tools');assert.equal(tools.first,false);assert.equal(tools.second,false);assert.equal(tools.third,true);assert.match(tools.reason,/搜索次数/);
    if(learning){assert.match(firstEvents.find(e=>e.kind==='prompt').text,/喜欢喝黑咖啡/);assert.equal(analysisRequests.length,1);assert.equal(analysisRequests[0].tools,undefined);assert.equal(social.cognition.jobs[0].inputTokens,123);}
    if(changePolicy){settings.social.filesEnabled=true;await writeFile(settingsPath,JSON.stringify(settings));await wait(()=>output.includes('reloaded from file'));}
    send(2);await wait(()=>replies.length===2);
    const current=(await data('sessions.json')).sessions['group:30001'];
    if(fail){assert.equal(current.sessionId,original);assert.match(JSON.stringify(replies[1]),/没处理成功/);send(3);await wait(()=>replies.length===3);}
    else {assert.notEqual(current.sessionId,original);assert.equal(current.generation,2);}
    const prompts=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.kind==='prompt');
    const creations=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.kind==='new');
    const envOf=entry=>Object.fromEntries(entry.servers[0].env.map(e=>[e.name,e.value]));assert.notEqual(envOf(creations[0]).BOT_ACTION_CONTEXT,envOf(creations.at(-1)).BOT_ACTION_CONTEXT);
    if(changePolicy)assert.ok(JSON.parse(envOf(creations.at(-1)).BOT_QQ_TOOLS).includes('qq_send_file'));
    assert.match(prompts.at(-1).text,/会话换代交接/);assert.match(prompts.at(-1).text,/已处理测试消息 1/);
    assert.equal((await data('sessions.json')).sessions['group:30001'].generation,2);
    assert.doesNotMatch(output,/Invalid params|unhandled/i);
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,6000).unref())]);if(child.exitCode===null)child.kill('SIGKILL');}
    for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));http.closeAllConnections();await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
test('真实桥接消费上下文上报、过滤工具并交接已发送消息后更换会话',{timeout:20000},()=>scenario(false));
test('新会话创建失败保留旧映射和记录，下次成功后才完成换代',{timeout:20000},()=>scenario(true));
test('后台调度经真实无工具 HTTP 分析写入来源记忆并注入后续 ACP 对话',{timeout:20000},()=>scenario(false,true));
test('工具设置热变更在下一轮重建清单并轮换内部凭据',{timeout:20000},()=>scenario(false,false,true));
