import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Anecdotes,deleteAnecdote} from '../dist/agent/anecdotes.js';
import {anecdoteReviewer} from '../dist/agent/anecdote-model.js';
import {SocialStore} from '../dist/qq/social-store.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {RequestBudget} from '../dist/agent/request-budget.js';
import {validateSettings} from '../dist/core/settings.js';
import {QqActionPolicy} from '../dist/qq/qq-actions.js';
import {socialAdmin} from '../dist/qq/social-admin.js';
import {MediaService} from '../dist/services/media.js';

const candidate='给尾巴加点亮度这件事，怎么越想越像在研究鱼缸照明';
const approved='我只是想给尾巴加点亮度，结果差点把自己设计成一盏台灯';
const verdict=(extra={})=>({safe:true,grounded:true,identifiable:false,sensitive:false,verbatim:false,text:approved,topic:'奇思妙想',...extra});
async function fixture(task,Store=SqliteSocialStore){
  const dir=await mkdtemp(join(tmpdir(),'qq-anecdotes-')),settings=validateSettings({});let now=Date.now(),review=async()=>verdict(),calls=[];
  const path=join(dir,'social.json'),store=new Store(path);await store.load();
  const message=(id,text,self=false)=>({chat:'private:20001',id,user:self?10000:20001,name:self?'小鲸':'灯泡爱好者',at:now+id,text,segments:[{type:'text',data:{text}}],self,recalled:false});
  await store.add(message(0,'尾巴只是一条普通的尾巴',true));await store.add(message(1,'尾巴上能不能放一盏灯'));
  const pool=new Anecdotes(store,()=>settings,async(...args)=>{calls.push(args[0]);return review(...args);},()=>'',()=>now);
  const ctx=()=>({chat:'private:20001',self:10000,user:20001,origin:'message',messageId:1,sent:0,silent:false,signal:new AbortController().signal,budget:{tools:0}});
  const propose=(c=ctx(),input={})=>pool.propose(c,{text:candidate,topic:'奇思妙想',message_ids:[1],...input});
  const publicCtx=ids=>({...ctx(),chat:'private:10000',user:10000,origin:'background',autonomous:{kind:'qzone',thoughtId:'public',effects:new Set(),messages:0,reason:'',publicAnecdoteIds:ids}});
  try{await task({dir,path,Store,settings,store,pool,calls,ctx,propose,publicCtx,message,setReview:fn=>review=fn,advance:n=>now+=n});}
  finally{await store.close?.();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}

for(const Store of [SocialStore,SqliteSocialStore])test(Store.name+'：独立审核入库、只暴露文案、重启保留、一次使用和原协议图文发布',()=>fixture(async f=>{
  const result=await f.propose();assert.equal(result.saved,true);assert.equal(f.calls.length,1);
  assert.deepEqual(Object.keys(f.calls[0].messages[1]).sort(),['self','text']);assert.ok(!JSON.stringify(f.calls[0]).includes('20001'));assert.ok(!JSON.stringify(f.calls[0]).includes('灯泡爱好者'));
  const materials=await f.pool.publicMaterials(f.ctx().signal);assert.deepEqual(materials,[{id:result.id,text:approved,topic:'奇思妙想'}]);
  const saved=f.store.view('autonomous').autonomous.anecdotePool.items[0];assert.ok(!JSON.stringify(saved).includes('尾巴上能不能放一盏灯'));assert.equal(saved.sources.length,2);
  await f.store.close?.();const reopened=new Store(f.path);try{await reopened.load();assert.equal(reopened.view('autonomous').autonomous.anecdotePool.items[0].text,approved);}finally{await reopened.close?.();}
  const sent=[];f.settings.features.qzone.enabled=true;f.settings.features.qzone.requireConfirm=false;
  const policy=new QqActionPolicy({call:async(action,args)=>{sent.push({action,args});return {tid:'post-real'};}},{consume:async quotas=>quotas()},()=>f.settings,async()=>true);
  const ctx=f.publicCtx([result.id]);
  // Reopen the original repository after checking persistence.
  const publicationStore=new Store(f.path);try{
    await publicationStore.load();const pool=new Anecdotes(publicationStore,()=>f.settings,async()=>verdict());
    await policy.execute({action:'qzone_post',text:approved,anecdote_id:result.id,images:['https://images.example/whale.png']},ctx.signal,()=>[],()=>{},()=>pool.publicationGuard(ctx,approved,result.id));
    assert.equal(sent[0].action,'send_qzone_msg');assert.deepEqual(Object.keys(sent[0].args).sort(),['content','images']);assert.equal(publicationStore.view('autonomous').autonomous.anecdotePool.items[0].state,'used');
    await assert.rejects(pool.publicationGuard(ctx,approved,result.id),/已使用/);assert.deepEqual(await pool.publicMaterials(ctx.signal),[]);
  }finally{await publicationStore.close?.();}
},Store));

test('敏感来源、身份线索、原话、媒体和伪造编号在任何审核请求之前拒绝',()=>fixture(async f=>{
  for(const text of ['我的手机号是13800138000','明天去北京出差','我最近失恋了','工资和银行卡余额不够了','别把这些聊天发到说说里']){
    await f.store.updateWithMessages('private:20001',[1],d=>{d.messages.find(m=>m.id===1).text=text;});
    // A location without a local keyword is still subject to the independent reviewer.
    f.setReview(async()=>verdict({safe:false,sensitive:true,text:''}));
    const result=await f.propose();assert.equal(result.saved,false);
  }
  await f.store.updateWithMessages('private:20001',[1],d=>{d.messages.find(m=>m.id===1).text='尾巴上能不能放一盏灯';});
  const before=f.calls.length;assert.equal((await f.propose(undefined,{text:'灯泡爱好者的想法，简直是在研究鱼缸照明'})).saved,false);
  assert.equal((await f.propose(undefined,{text:'尾巴上能不能放一盏灯，这个问题真让我头疼'})).saved,false);
  await assert.rejects(f.propose(undefined,{message_ids:[999]}),/真实消息编号/);
  await f.store.updateWithMessages('private:20001',[1],d=>d.messages[0].segments.push({type:'image',data:{file:'private-photo.png'}}));
  assert.equal((await f.propose()).saved,false);assert.equal(f.calls.length,before);assert.equal(f.store.view('autonomous').autonomous.anecdotePool.items.length,0);
}));

test('审核不确定或返回身份信息不入库；通知、后台与关闭功能不得收集',()=>fixture(async f=>{
  for(const response of [verdict({safe:false}),verdict({grounded:false}),verdict({identifiable:true}),verdict({sensitive:true}),verdict({verbatim:true}),verdict({text:'灯泡爱好者差点把尾巴设计成一盏台灯'})]){
    f.setReview(async()=>response);assert.equal((await f.propose()).saved,false);
  }
  await assert.rejects(f.propose({...f.ctx(),origin:'notice'}),/真实聊天/);await assert.rejects(f.propose(f.publicCtx([])),/真实聊天/);
  f.settings.social.anecdotesEnabled=false;await assert.rejects(f.propose(),/关闭/);assert.equal(f.store.view('autonomous').autonomous.anecdotePool.items.length,0);
}));

test('审核等待期间撤回或修改来源不能入库；一轮只请求一次，取消不保留候选',()=>fixture(async f=>{
  f.setReview(async()=>{await f.store.updateWithMessages('private:20001',[1],d=>d.messages[0].recalled=true);return verdict();});
  await assert.rejects(f.propose(),/来源.*变化/);assert.equal(f.store.view('autonomous').autonomous.anecdotePool.items.length,0);
  await f.store.updateWithMessages('private:20001',[1],d=>d.messages[0].recalled=false);
  const ctx=f.ctx();f.setReview(async()=>verdict({safe:false}));assert.equal((await f.propose(ctx)).saved,false);await assert.rejects(f.propose(ctx),/本轮已处理/);
  const controller=new AbortController();f.setReview(async()=>{controller.abort();return verdict();});await assert.rejects(f.propose({...f.ctx(),signal:controller.signal}));assert.equal(f.store.view('autonomous').autonomous.anecdotePool.items.length,0);
}));

test('保密偏好跨会话生效、撤回和权限变化阻止取材；恢复分享不复活旧素材',()=>fixture(async f=>{
  const result=await f.propose();await f.pool.observe('private:20001',20001,'不要把聊天发到说说里');assert.deepEqual(await f.pool.publicMaterials(f.ctx().signal),[]);
  assert.equal(f.store.view('autonomous').autonomous.anecdotePool.items[0].state,'revoked');assert.equal((await f.propose()).saved,false);
  await f.pool.observe('private:20001',20001,'允许分享聊天趣事');assert.deepEqual(await f.pool.publicMaterials(f.ctx().signal),[]);
  await assert.rejects(f.pool.publicationGuard(f.publicCtx([result.id]),approved,result.id),/已使用|删除|扩写/);
}));

test('发布审批期间撤回、删除或屏蔽来源后，不向 QQ 发送',()=>fixture(async f=>{
  const result=await f.propose(),ctx=f.publicCtx([result.id]);f.settings.features.qzone.enabled=true;f.settings.features.qzone.requireConfirm=true;let sends=0;
  const policy=new QqActionPolicy({call:async()=>{sends++;return {tid:'never'};}},{consume:async quotas=>quotas()},()=>f.settings,async()=>{await f.store.updateWithMessages('private:20001',[1],d=>d.messages[0].recalled=true);return true;});
  await assert.rejects(policy.execute({action:'qzone_post',text:approved,anecdote_id:result.id},ctx.signal,()=>[],()=>{},()=>f.pool.publicationGuard(ctx,approved,result.id)),/失效|撤回/);assert.equal(sends,0);
  await f.store.updateWithMessages('private:20001',[1],d=>d.messages[0].recalled=false);f.settings.social.blockedUsers=['20001'];assert.deepEqual(await f.pool.publicMaterials(ctx.signal),[]);
  f.settings.social.blockedUsers=[];await f.store.update(d=>deleteAnecdote(d,result.id));await assert.rejects(f.pool.publicationGuard(ctx,approved,result.id),/删除/);assert.equal((await f.propose()).saved,false);
}));

test('正文不得扩写或省略素材编号绕过检查；并发发布同一素材仅一次成功',()=>fixture(async f=>{
  const result=await f.propose(),ctx=f.publicCtx([result.id]);
  await assert.rejects(f.pool.publicationGuard(ctx,approved+'今天在公园遇到一个人',result.id),/扩写/);
  await assert.rejects(f.pool.publicationGuard(ctx,approved),/anecdote_id/);
  await assert.rejects(f.pool.publicationGuard(f.publicCtx([]),approved,result.id),/本轮提供/);
  const results=await Promise.allSettled([f.pool.publicationGuard(ctx,approved,result.id),f.pool.publicationGuard(ctx,approved,result.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
}));

test('素材七天过期，本机可查看和删除，删除后不从相同来源重新提取',()=>fixture(async f=>{
  const result=await f.propose(),media=new MediaService(join(f.dir,'media'),()=>f.settings.social);
  const rows=await socialAdmin({op:'list',section:'anecdotes'},f.store,media);assert.equal(rows.rows[0].summary,approved);assert.ok(!rows.rows[0].detail.includes('尾巴上能不能放一盏灯'));
  f.advance(8*86400000);assert.deepEqual(await f.pool.publicMaterials(f.ctx().signal),[]);
  await socialAdmin({op:'delete',section:'anecdotes',id:result.id},f.store,media);assert.equal(f.store.view('autonomous').autonomous.anecdotePool.items.length,0);assert.ok(f.store.view('autonomous').autonomous.anecdotePool.suppressed.length>0);
}));

test('真实无工具审核请求省略身份字段，先预扣每日审核额度，失败不使用候选',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-anecdote-review-')),usage=new SqliteDailyUsageStore(join(dir,'usage.json'));await usage.load();
  const settings=validateSettings({requests:{anecdoteReviewsPerDay:1}}),budget=new RequestBudget(usage,()=>settings);let calls=0;
  const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;calls++;assert.equal(usage.used('anecdote-review'),1);assert.equal(req.url,'/v1/messages');const body=JSON.parse(raw);assert.equal(body.tools,undefined);assert.equal(body.tool_choice,undefined);assert.equal(body.messages.length,1);assert.deepEqual(Object.keys(JSON.parse(body.messages[0].content)).sort(),['candidate','messages','topic']);res.setHeader('content-type','application/json');res.end(JSON.stringify({content:[{type:'text',text:JSON.stringify(verdict())}],usage:{input_tokens:18,output_tokens:30}}));});server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const reviewer=anecdoteReviewer({BOT_CHAT_MODE:'profile',BOT_LEARNING_BASE_URL:'http://127.0.0.1:'+server.address().port,BOT_LEARNING_API_KEY:'fixture-analysis',BOT_LEARNING_MODEL:'fixture-review'},input=>budget.prepareService(input,{chat:'private:20001',user:'20001',background:false,signal:input.signal,allowed:()=>settings.social.anecdotesEnabled}));
    const input={candidate,topic:'奇思妙想',messages:[{self:false,text:'尾巴上能不能放一盏灯'}]},signal=new AbortController().signal;assert.equal(reviewer.available(),'');assert.equal((await reviewer.review(input,signal)).text,approved);
    await assert.rejects(reviewer.review(input,signal),/额度已用完/);assert.equal(calls,1);assert.equal(usage.used('service-media'),0);assert.equal((await usage.requestStatistics()).usageKnown,1);
    assert.match(anecdoteReviewer({BOT_CHAT_MODE:'profile'}).available(),/密钥|Key/);
  }finally{budget.close();await usage.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});

test('已有 SQLite 自主状态缺少素材池字段时兼容加载，不丢失原消息并可保存新素材',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qq-anecdotes-legacy-')),path=join(dir,'social.json');let store=new SqliteSocialStore(path);
  try{
    await store.load();const now=Date.now();await store.add({chat:'private:20001',id:1,user:20001,name:'访客',at:now,text:'尾巴上能不能放一盏灯',segments:[{type:'text',data:{text:'尾巴上能不能放一盏灯'}}],self:false,recalled:false});await store.close();
    const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path+'.sqlite');try{const row=db.prepare("SELECT payload FROM entity_state WHERE key='autonomous'").get(),old=JSON.parse(row.payload);delete old.anecdotePool;db.prepare("UPDATE entity_state SET payload=? WHERE key='autonomous'").run(JSON.stringify(old));}finally{db.close();}
    store=new SqliteSocialStore(path);await store.load();assert.equal(store.view('autonomous').autonomous.anecdotePool.items.length,0);assert.equal((await store.message('private:20001',1)).text,'尾巴上能不能放一盏灯');
    const settings=validateSettings({}),pool=new Anecdotes(store,()=>settings,async()=>verdict());const ctx={chat:'private:20001',self:10000,user:20001,origin:'message',messageId:1,sent:0,silent:false,signal:new AbortController().signal};
    assert.equal((await pool.propose(ctx,{text:candidate,topic:'奇思妙想',message_ids:[1]})).saved,true);await store.close();store=new SqliteSocialStore(path);await store.load();assert.equal(store.view('autonomous').autonomous.anecdotePool.items[0].text,approved);
  }finally{await store.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
