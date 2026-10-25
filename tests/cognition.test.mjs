import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../dist/social-store.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { DailyUsageStore } from '../dist/usage.js';
import { Cognition, cognitionRevision, recall, reviseMemory, forgetMemory } from '../dist/cognition.js';
import { MemoryMetaSchema } from '../dist/cognition-state.js';
import { socialAdmin } from '../dist/social-admin.js';
import { MediaService } from '../dist/media.js';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qq-cognition-')),now=Date.now(),chat='group:30001';
  const store=new SocialStore(join(root,'social.json'));await store.load();
  const settings=structuredClone(DEFAULT_SETTINGS);Object.assign(settings.learning,{memory:true,lexicon:true,chats:[chat],minMessages:3,idleMinutes:1,intervalMinutes:5});
  const usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();
  const messages=[{id:1,user:20001,text:'我一直喜欢喝黑咖啡，下班就开一局。'},{id:2,user:20002,text:'今天下班，游戏结束啦。'},{id:3,user:20001,text:'下班，明天继续玩。'}].map((m,i)=>({...m,chat,name:'用户'+m.user,at:now-600000+i,text:m.text,segments:[{type:'text',data:{text:m.text}}],self:false,recalled:false}));
  for(const m of messages)await store.add(m);
  const proposal={memories:[{user:'20001',text:'喜欢喝黑咖啡',evidence:[{messageId:1,quote:'我一直喜欢喝黑咖啡'}]}],lexicon:[{term:'下班',meaning:'结束当前游戏',kind:'term',evidence:messages.map(m=>({messageId:m.id,quote:m.text}))}]};
  const batch=()=>({chat,messages:store.messages(chat,100),memories:store.memories(chat),revision:cognitionRevision(store.snapshot(),chat)});
  try{await run({root,store,settings,usage,now,chat,messages,proposal,batch});}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
}

test('v1 社交数据无损迁移，备份原始字节并标记旧记忆锁定，损坏文件保留',()=>fixture(async({root})=>{
  const path=join(root,'old.json'),raw=JSON.stringify({version:1,account:10000,messages:[],contacts:[],memories:[{id:'old',chat:'private:20001',user:'20001',name:'旧好友',text:'不喝咖啡',at:1}],stickers:[],tasks:[],events:[],actions:[],turns:[]});
  await writeFile(path,raw);const store=new SocialStore(path);await store.load();
  assert.equal(store.snapshot().version,2);assert.equal(store.memories('private:20001')[0].text,'不喝咖啡');assert.equal(store.snapshot().cognition.memories.old.locked,true);
  const backup=(await readdir(root)).find(n=>n.startsWith('old.json.v1-'));assert.equal(await readFile(join(root,backup),'utf8'),raw);
  await writeFile(path,raw);await writeFile(join(root,backup),'damaged backup');await assert.rejects(new SocialStore(path).load(),/备份与原文件不一致/);assert.equal(await readFile(path,'utf8'),raw);await writeFile(join(root,backup),raw);await new SocialStore(path).load();
  await new SocialStore(path).load();assert.equal((await readdir(root)).filter(n=>n.startsWith('old.json.v1-')).length,1);
  await writeFile(join(root,'bad.json'),'{broken');await assert.rejects(new SocialStore(join(root,'bad.json')).load());assert.equal(await readFile(join(root,'bad.json'),'utf8'),'{broken');
}));

test('旧的相关记忆仍能召回，隔离来源群、屏蔽用户和撤回来源；预算保留完整条目',()=>fixture(async({store,settings,chat,now})=>{
  await store.update(d=>{
    d.memories.push({id:'coffee',chat,user:'20001',name:'甲',text:'喜欢黑咖啡',at:now-100000});
    for(let i=0;i<40;i++)d.memories.push({id:'noise'+i,chat,user:'20002',name:'乙',text:'临时记录'+i,at:now+i});
    d.memories.push({id:'other',chat:'group:40001',user:'20001',name:'甲',text:'OTHER_SECRET',at:now});
  });
  let result=recall(store.snapshot(),settings,chat,'20001','咖啡');assert.match(result.memories,/喜欢黑咖啡/);assert.doesNotMatch(result.memories,/OTHER_SECRET/);
  settings.social.blockedUsers=['20002'];assert.doesNotMatch(recall(store.snapshot(),settings,chat,'20001','咖啡').memories,/临时记录/);
  await store.update(d=>{d.cognition.memories.coffee=MemoryMetaSchema.parse({source:'learned',sources:[1],locked:false});d.messages.find(m=>m.id===1).recalled=true;});
  assert.doesNotMatch(recall(store.snapshot(),settings,chat,'20001','咖啡').memories,/喜欢黑咖啡/);
  settings.learning.memoryChars=1;assert.equal(recall(store.snapshot(),settings,chat,'20001','咖啡').memories,'');
}));

test('一次受限分析生成记忆与待确认词条，管理端确认后只在本群召回',()=>fixture(async({root,store,settings,usage,proposal,batch,chat})=>{
  const service=new Cognition(store,()=>settings,usage,async()=>proposal);await service.run(batch(),new AbortController().signal);
  let data=store.snapshot();assert.equal(data.memories.length,1);assert.equal(data.cognition.lexicon[0].status,'candidate');assert.equal(usage.used('learning'),1);
  assert.equal(recall(data,settings,chat,'20001','下班').lexicon,'');
  const media=new MediaService(join(root,'media'),()=>settings.social),id=data.cognition.lexicon[0].id;
  await socialAdmin({op:'activate_lexicon',section:'lexicon',id},store,media);
  assert.match(recall(store.snapshot(),settings,chat,'20001','下班').lexicon,/结束当前游戏/);
  assert.equal(recall(store.snapshot(),settings,'group:40001','20001','下班').lexicon,'');
  await socialAdmin({op:'disable_lexicon',section:'lexicon',id},store,media);
  assert.equal(recall(store.snapshot(),settings,chat,'20001','下班').lexicon,'');
}));

test('伪造、重复、他人、转述和敏感来源不会写入；词条需要不同发送者',()=>fixture(async({store,settings,usage,proposal,batch})=>{
  const bad=structuredClone(proposal);bad.memories=[
    {user:'20002',text:'喜欢喝黑咖啡',evidence:[{messageId:1,quote:'喜欢喝黑咖啡'}]},
    {user:'20001',text:'伪造的事实',evidence:[{messageId:999,quote:'伪造的事实'}]},
    {user:'20001',text:'完全猜测',evidence:[{messageId:1,quote:'喜欢喝黑咖啡'}]},
  ];bad.lexicon[0].evidence=[bad.lexicon[0].evidence[0],bad.lexicon[0].evidence[0],bad.lexicon[0].evidence[0]];
  await new Cognition(store,()=>settings,usage,async()=>bad).run(batch(),new AbortController().signal);
  assert.equal(store.snapshot().memories.length,0);assert.equal(store.snapshot().cognition.lexicon.length,0);
}));

test('分析期间管理员编辑或开关改变时不覆盖；来源撤回也不写入',()=>fixture(async({store,settings,usage,proposal,batch})=>{
  const before=batch();
  await new Cognition(store,()=>settings,usage,async()=>{await store.update(d=>{d.memories.push({id:'manual',chat:before.chat,user:'20001',name:'甲',text:'管理员事实',at:Date.now()});});return proposal;}).run(before,new AbortController().signal);
  assert.equal(store.snapshot().memories.length,1);assert.equal(store.snapshot().cognition.jobs.at(-1).state,'discarded');
  await new Cognition(store,()=>settings,usage,async()=>{settings.learning.memory=false;settings.learning.lexicon=false;return proposal;}).run(batch(),new AbortController().signal);
  assert.equal(store.snapshot().memories.length,1);assert.equal(store.snapshot().cognition.lexicon.length,0);
  settings.learning.memory=true;
  await new Cognition(store,()=>settings,usage,async()=>{await store.update(d=>{d.messages.find(m=>m.id===1).recalled=true;});return proposal;}).run(batch(),new AbortController().signal);
  assert.equal(store.snapshot().memories.length,1);
}));

test('记忆更新保留版本、管理员锁定阻止替代，删除后旧证据不会重新学回',()=>fixture(async({store,settings,usage,proposal,batch})=>{
  const service=new Cognition(store,()=>settings,usage,async()=>proposal);await service.run(batch(),new AbortController().signal);
  const id=store.snapshot().memories[0].id;
  await store.update(d=>reviseMemory(d,id,'管理员修正'));
  assert.equal(store.snapshot().cognition.memories[id].history[0].text,'喜欢喝黑咖啡');
  const replacement=structuredClone(proposal);replacement.memories[0].replaceId=id;
  await new Cognition(store,()=>settings,usage,async()=>replacement).run(batch(),new AbortController().signal);
  assert.equal(store.snapshot().memories.length,1);
  await store.update(d=>{reviseMemory(d,id,'喜欢喝黑咖啡');forgetMemory(d,id);});
  await service.run(batch(),new AbortController().signal);assert.equal(store.snapshot().memories.length,0);
}));

test('调度尊重繁忙、会话范围与额度，重启不重复分析；同秒剩余消息仍被处理',()=>fixture(async({root,store,settings,usage,proposal,chat,now})=>{
  let calls=0,clock=now;const service=new Cognition(store,()=>settings,usage,async()=>{calls++;return proposal;},()=>'',()=>clock);
  await service.tick(new AbortController().signal,()=>true);assert.equal(calls,0);
  settings.learning.chats=[];await service.tick(new AbortController().signal,()=>false);assert.equal(calls,0);
  settings.learning.chats=[chat];await service.tick(new AbortController().signal,()=>false);assert.equal(calls,1);
  const restart=new SocialStore(store.path);await restart.load();clock+=3600000;
  const again=new Cognition(restart,()=>settings,usage,async()=>{calls++;return {memories:[],lexicon:[]};},()=>'',()=>clock);
  await again.tick(new AbortController().signal,()=>false);assert.equal(calls,1);
  const at=restart.snapshot().cognition.scopes[chat].cursor;
  for(const id of [4,5,6])await restart.add({chat,id,user:20001,name:'甲',text:'新的明确消息'+id,at,segments:[{type:'text',data:{text:'新的明确消息'+id}}],self:false,recalled:false});
  await again.tick(new AbortController().signal,()=>false);assert.equal(calls,2);
  settings.learning.dailyCalls=2;clock+=3600000;
  for(const id of [7,8,9])await restart.add({chat,id,user:20001,name:'甲',text:'更多消息'+id,at:at+1,segments:[{type:'text',data:{text:'更多消息'+id}}],self:false,recalled:false});
  await again.tick(new AbortController().signal,()=>false);assert.equal(calls,2);
}));

test('分析失败保留额度与游标，中断任务重启标记待核对',()=>fixture(async({store,settings,usage,batch})=>{
  await new Cognition(store,()=>settings,usage,async()=>{throw new Error('upstream');}).run(batch(),new AbortController().signal);
  assert.equal(usage.used('learning'),1);assert.equal(store.snapshot().cognition.jobs[0].state,'failed');
  await store.update(d=>{d.cognition.jobs[0].state='running';});const restart=new SocialStore(store.path);await restart.load();assert.equal(restart.snapshot().cognition.jobs[0].state,'unknown');
}));

test('否定语境不能被裁剪成相反事实，长期记忆保留短证据且记录服务用量',()=>fixture(async({store,settings,usage,batch,chat})=>{
  await store.update(d=>{d.messages.find(m=>m.id===1).text='我不喜欢黑咖啡';});
  const wrong={memories:[{user:'20001',text:'喜欢黑咖啡',evidence:[{messageId:1,quote:'喜欢黑咖啡'}]}],lexicon:[]};
  await new Cognition(store,()=>settings,usage,async()=>wrong).run(batch(),new AbortController().signal);assert.equal(store.snapshot().memories.length,0);
  const correct={memories:[{user:'20001',text:'不喜欢黑咖啡',evidence:[{messageId:1,quote:'我不喜欢黑咖啡'}]}],lexicon:[]};
  await new Cognition(store,()=>settings,usage,async()=>({proposal:correct,usage:{inputTokens:12,outputTokens:3}})).run(batch(),new AbortController().signal);
  assert.equal(store.snapshot().cognition.jobs.at(-1).inputTokens,12);
  await store.update(d=>{d.messages=[];});assert.match(recall(store.snapshot(),settings,chat,'20001','咖啡').memories,/不喜欢黑咖啡/);
}));
