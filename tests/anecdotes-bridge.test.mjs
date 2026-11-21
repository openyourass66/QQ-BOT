import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readSocialData} from './helpers/social-data.mjs';

const approved='我只是想给尾巴加点亮度，结果差点把自己设计成一盏台灯';
test('真实聊天经独立审核形成趣事，公开创作只收到文案，选图库图并发布一次',{timeout:25000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-anecdotes-bridge-')),posts=[],sent=[],reviews=[];let now=Date.now(),child,output='',next=100;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const args=JSON.parse(raw||'{}');res.setHeader('content-type','application/json');
    if(req.url==='/v1/messages'){reviews.push(args);res.end(JSON.stringify({content:[{type:'text',text:JSON.stringify({safe:true,grounded:true,identifiable:false,sensitive:false,verbatim:false,text:approved,topic:'奇思妙想'})}]}));return;}
    let data=req.url==='/get_login_info'?{user_id:10000,nickname:'小鲸'}:{};if(req.url==='/send_private_msg'){sent.push(args);data={message_id:next++};}if(req.url==='/send_qzone_msg'){posts.push(args);data={tid:'story-'+next++};}res.end(JSON.stringify({status:'ok',retcode:0,data}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');const ws=new WebSocketServer({host:'127.0.0.1',port:0});if(!ws.address())await once(ws,'listening');
  const until=async check=>{const end=Date.now()+8000;while(!await check()){if(Date.now()>end)throw new Error('趣事链路超时\n'+output);await new Promise(done=>setTimeout(done,25));}};
  try{
    const clock=join(dir,'clock'),events=join(dir,'model-events.jsonl');await writeFile(clock,String(now));
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64'),hash=createHash('sha256').update(png).digest('hex');await mkdir(join(dir,'media'));await writeFile(join(dir,'media',hash+'.png'),png);
    const thought={id:'public-story',key:'public-story',chat:'',kind:'qzone',summary:'分享具体趣事',reason:'独立创作机会',at:now,due:now+30000,expires:now+86400000,priority:30,state:'pending',result:''};
    await writeFile(join(dir,'social.json'),JSON.stringify({version:2,account:10000,messages:[],contacts:[],memories:[],stickers:[],images:[{id:'image:'+hash,file:hash+'.png',description:'台灯旁的小鲸鱼',tags:['台灯'],source:{local:true},at:now}],tasks:[],events:[],actions:[],turns:[],autonomous:{lastScanAt:now,thoughts:[thought]}}));
    await writeFile(join(dir,'settings.json'),JSON.stringify({chat:{delay:{minMs:0,maxMs:0}},features:{qzone:{enabled:true,requireConfirm:false}},social:{anecdotesEnabled:true,proactiveEnabled:true,autoCollectStickers:false,quietStartHour:0,quietEndHour:0}}));
    const wrapper=join(dir,process.platform==='win32'?'agent.cmd':'agent'),script=resolve('tests/fixtures/fake-dsh.mjs');await writeFile(wrapper,process.platform==='win32'?'@echo off\r\n"'+process.execPath+'" "'+script+'"\r\n':'#!/bin/sh\nexec "'+process.execPath+'" "'+script+'"\n',{mode:0o700});
    const connected=once(ws,'connection');child=spawn(process.execPath,[resolve('dist/bridge.js')],{env:{...process.env,BOT_DSH_BIN:wrapper,BOT_WORKSPACE:dir,ONEBOT_HTTP_URL:'http://127.0.0.1:'+server.address().port,ONEBOT_WS_URL:'ws://127.0.0.1:'+ws.address().port,SESSION_STORE:join(dir,'sessions.json'),BOT_SOCIAL_STORE:join(dir,'social.json'),BOT_SETTINGS_FILE:join(dir,'settings.json'),BOT_MEDIA_DIR:join(dir,'media'),BOT_SELF_ID:'10000',TURN_TIMEOUT_MS:'6000',BOT_CHAT_MODE:'profile',BOT_LEARNING_BASE_URL:'http://127.0.0.1:'+server.address().port,BOT_LEARNING_API_KEY:'fixture-review-key',BOT_LEARNING_MODEL:'fixture-review',FAKE_ANECDOTES:'1',FAKE_AUTONOMY_CLOCK:clock,FAKE_AUTONOMY_EVENTS:events,NODE_OPTIONS:'--import='+pathToFileURL(resolve('tests/fixtures/autonomy-clock.mjs')).href},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
    const [socket]=await connected;socket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:10000,user_id:20001,time:Math.floor(now/1000),message_id:1,message:[{type:'text',data:{text:'尾巴上能不能放一盏灯'}}],sender:{user_id:20001,nickname:'私聊访客'}}));
    const data=()=>readSocialData(join(dir,'social.json'));await until(async()=>(await data()).autonomous.anecdotePool.items.length===1);assert.equal(reviews.length,1);assert.equal(reviews[0].tools,undefined);assert.doesNotMatch(reviews[0].messages[0].content,/私聊访客|20001/);
    now+=60000;await writeFile(clock,String(now));await until(()=>posts.length===1);await until(async()=>(await data()).autonomous.posts[0]?.state==='success');
    assert.equal(posts[0].content,approved);assert.equal(posts[0].images.length,1);assert.deepEqual(await readFile(fileURLToPath(posts[0].images[0])),png);assert.equal((await data()).autonomous.anecdotePool.items[0].state,'used');
    const eventRows=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse),publicPrompt=eventRows.find(row=>row.public).prompt;assert.ok(publicPrompt.includes(approved));assert.doesNotMatch(publicPrompt,/尾巴上能不能放一盏灯|私聊访客|20001/);assert.equal(sent.length,1);
  }finally{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));server.closeAllConnections();await new Promise(done=>server.close(done));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
