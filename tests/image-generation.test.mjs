import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateSettings} from '../dist/core/settings.js';
import {MediaService} from '../dist/services/media.js';
import {SocialStore} from '../dist/qq/social-store.js';
import {SocialEngine} from '../dist/qq/social-engine.js';
import {RequestBudget} from '../dist/agent/request-budget.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {QqActionPolicy} from '../dist/qq/qq-actions.js';
import {validateMediaService} from '../desktop/settings-config.mjs';
import {validateRuntimeEnv} from '../desktop/runtime-fields.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=';
async function fixture(task){
  const dir=await mkdtemp(join(tmpdir(),'qq-generate-')),settings=validateSettings({});
  const old=Object.fromEntries(['BOT_IMAGE_BASE_URL','BOT_IMAGE_API_KEY'].map(k=>[k,process.env[k]]));
  let reply={data:[{b64_json:png}]},status=200,afterRequest=()=>{},beforeDispatch=()=>{};const calls=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,headers:req.headers,body:JSON.parse(raw)});afterRequest();res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(reply));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  process.env.BOT_IMAGE_BASE_URL='http://127.0.0.1:'+server.address().port+'/v1/';process.env.BOT_IMAGE_API_KEY='image-fixture-secret';
  const usage=new SqliteDailyUsageStore(join(dir,'usage.json'));await usage.load();const budget=new RequestBudget(usage,()=>settings);
  const ctx={chat:'private:2',self:1,user:2,origin:'message',sent:0,silent:false,signal:new AbortController().signal};
  const media=new MediaService(join(dir,'media'),()=>settings.social,async input=>{const prepared=await budget.prepareService(input,{chat:ctx.chat,user:'2',background:Boolean(ctx.autonomous),signal:ctx.signal,allowed:()=>settings.social.mediaEnabled&&settings.social.imageGenerationEnabled});beforeDispatch();return prepared;});
  const store=new SocialStore(join(dir,'social.json'));await store.load();const sent=[];
  const api={call:async(action,args)=>{sent.push({action,args});return action==='send_qzone_msg'?{tid:'generated-post'}:{message_id:100};}};
  const engine=new SocialEngine(store,media,api,usage,()=>settings,async()=>true,()=>{},()=>{});
  const generate=()=>engine.execute({action:'social',tool:'qq_generate_image',args:{prompt:'画一条蓝色小鲸鱼看星星，不含文字',description:'看星星的小鲸鱼',tags:['星空']}},ctx);
  try{await task({dir,settings,usage,budget,ctx,media,store,engine,api,sent,calls,generate,setReply:(r,s=200)=>{reply=r;status=s;},after:fn=>afterRequest=fn,beforeDispatch:fn=>beforeDispatch=fn});}
  finally{budget.close();await usage.close();await media.flush();server.closeAllConnections();await new Promise(done=>server.close(done));for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}
const enable=s=>Object.assign(s.social,{imageGenerationEnabled:true,imageGenerationModel:'fixture-image'});

test('生图配置默认关闭，地址和模型独立校验',()=>{
  const s=validateSettings({});assert.equal(s.social.imageGenerationEnabled,false);assert.equal(s.social.autoQzoneGenerateImages,false);assert.equal(s.requests.imageGenerationPerDay,3);
  enable(s);assert.throws(()=>validateMediaService(s,''),/图片生成/);
  validateMediaService(s,'BOT_IMAGE_BASE_URL=https://image.example/v1/');
  assert.throws(()=>validateRuntimeEnv('BOT_IMAGE_BASE_URL=https://user:pass@image.example/v1/'),/不可包含/);
  assert.throws(()=>validateSettings({social:{imageGenerationSize:'huge'}}));
});

test('真实 Images 请求生成入库，跨会话可检索并随自主说说发布',()=>fixture(async f=>{
  enable(f.settings);const saved=await f.generate();assert.match(saved.id,/^image:/);assert.equal(f.sent.length,0);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/v1/images/generations');assert.equal(f.calls[0].headers.authorization,'Bearer image-fixture-secret');
  assert.deepEqual(f.calls[0].body,{model:'fixture-image',prompt:'画一条蓝色小鲸鱼看星星，不含文字',n:1,size:'1024x1024'});
  assert.deepEqual(await readFile(f.engine.imageLibrary.path(saved.id)),Buffer.from(png,'base64'));
  assert.equal(f.engine.imageLibrary.search('星空',5)[0].id,saved.id);assert.equal(f.usage.used('image-generation'),1);assert.equal(f.usage.used('service-media'),1);
  Object.assign(f.settings.social,{proactiveEnabled:true,quietStartHour:0,quietEndHour:0});f.settings.features.qzone.enabled=true;f.settings.features.qzone.requireConfirm=false;
  const now=Date.now();await f.store.update(d=>d.autonomous.thoughts.push({id:'post-task',key:'post-task',chat:'',kind:'qzone',summary:'星空',reason:'公开感想',at:now,due:now,expires:now+60000,priority:30,state:'running',result:''}));
  f.ctx.autonomous={kind:'qzone',thoughtId:'post-task',effects:new Set(),messages:0,reason:''};
  const policy=new QqActionPolicy(f.api,f.usage,()=>f.settings,async()=>true);
  await f.engine.autonomy.publish(f.ctx,'今晚想看星星',[saved.id],(extra,images)=>policy.execute({action:'qzone_post',text:'今晚想看星星',images},f.ctx.signal,()=>extra),async id=>pathToFileURL(f.engine.imageLibrary.path(id)).href);
  assert.equal(f.sent[0].action,'send_qzone_msg');assert.equal(f.sent[0].args.images.length,1);assert.equal(f.ctx.autonomous.effects.has('qzone'),true);
}));

test('每日生图额度在请求前拒绝，服务失败仍计次且不泄漏密钥或自动重试',()=>fixture(async f=>{
  enable(f.settings);f.settings.requests.imageGenerationPerDay=1;f.setReply({error:{message:'image-fixture-secret'}},401);
  await assert.rejects(f.generate(),error=>/HTTP 401/.test(error.message)&&!error.message.includes('image-fixture-secret'));
  await assert.rejects(f.generate(),/额度已用完/);assert.equal(f.calls.length,1);assert.equal(f.usage.used('image-generation'),1);
  const stats=await f.usage.requestStatistics();assert.equal(stats.unknownResults,1);assert.equal(f.engine.imageLibrary.search('',10).length,0);
}));

test('拒绝无效图片、内网返回地址、关闭能力与取消请求，不生成库存记录',()=>fixture(async f=>{
  await assert.rejects(f.generate(),/关闭|未就绪/);assert.equal(f.calls.length,0);enable(f.settings);
  f.setReply({data:[{b64_json:Buffer.from('not an image').toString('base64')}]});await assert.rejects(f.generate(),/图片/);
  f.setReply({data:[{url:'http://127.0.0.1/private'}]});await assert.rejects(f.generate(),/内网/);
  f.setReply({data:[{b64_json:png}]});f.after(()=>f.settings.social.imageGenerationEnabled=false);await assert.rejects(f.generate(),/关闭|配置已变化/);
  assert.equal(f.engine.imageLibrary.search('',10).length,0);enable(f.settings);const controller=new AbortController();controller.abort();f.ctx.signal=controller.signal;await assert.rejects(f.generate());assert.equal(f.calls.length,3);
}));

test('自主生图需单独开启，一轮至多尝试一次且不阻止文字发布',()=>fixture(async f=>{
  enable(f.settings);Object.assign(f.settings.social,{proactiveEnabled:true,quietStartHour:0,quietEndHour:0});f.settings.features.qzone.enabled=true;
  const now=Date.now();await f.store.update(d=>d.autonomous.thoughts.push({id:'post-task',key:'post-task',chat:'',kind:'qzone',summary:'星空',reason:'公开感想',at:now,due:now,expires:now+60000,priority:30,state:'running',result:''}));
  f.ctx.autonomous={kind:'qzone',thoughtId:'post-task',effects:new Set(),messages:0,reason:''};
  await assert.rejects(f.generate(),/开启说说配图/);assert.equal(f.calls.length,0);
  f.settings.social.autoQzoneGenerateImages=true;f.setReply({},503);await assert.rejects(f.generate(),/HTTP 503/);
  await assert.rejects(f.generate(),/不会重复请求/);assert.equal(f.calls.length,1);assert.equal(f.ctx.autonomous.failure,undefined);
  f.engine.autonomy.authorize(f.ctx,'qzone_post');
}));

test('生图排队期间关闭自主开关，预扣后拒绝外部调用',()=>fixture(async f=>{
  enable(f.settings);Object.assign(f.settings.social,{proactiveEnabled:true,autoQzoneGenerateImages:true,quietStartHour:0,quietEndHour:0});f.settings.features.qzone.enabled=true;
  const now=Date.now();await f.store.update(d=>d.autonomous.thoughts.push({id:'queued-post',key:'queued-post',chat:'',kind:'qzone',summary:'星空',reason:'公开感想',at:now,due:now,expires:now+60000,priority:30,state:'running',result:''}));
  f.ctx.autonomous={kind:'qzone',thoughtId:'queued-post',effects:new Set(),messages:0,reason:''};
  f.beforeDispatch(()=>f.settings.social.autoQzoneGenerateImages=false);
  await assert.rejects(f.generate(),/开启说说配图/);assert.equal(f.calls.length,0);assert.equal(f.engine.imageLibrary.search('',10).length,0);
}));
