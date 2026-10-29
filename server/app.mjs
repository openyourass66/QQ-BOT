import Fastify from 'fastify';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createRuntimeService} from '../scripts/runtime-service.mjs';
import {prepareRuntime} from '../scripts/app-paths.mjs';
import {RuntimeConfiguration,ConfigurationError} from '../scripts/runtime-configuration.mjs';
import {OwnerAuth,AuthError} from './auth.mjs';
import {ManagementJobs,JobError} from './jobs.mjs';

const cookieName='whale_local_session';
const cookie=request=>{const values=String(request.headers.cookie||'').split(';').map(x=>x.trim());const matched=values.filter(x=>x.startsWith(cookieName+'='));return matched.length===1?matched[0].slice(cookieName.length+1):'';};
const sessionCookie=token=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
const strings=keys=>({type:'object',required:keys,additionalProperties:false,properties:Object.fromEntries(keys.map(key=>[key,{type:'string',maxLength:key==='password'?1024:128}]))});
export function managementEvent(event) {
  if(event.type==='state')return {type:'state',bridge:Boolean(event.bridge),napcat:Boolean(event.napcat),externalNapcat:Boolean(event.externalNapcat),busy:Boolean(event.busy),...(!event.bridge?{wsConnected:false,acpConnected:false}:{}),...(!event.napcat?{qqOnline:false}:{})};
  if(event.type==='control')return {type:'control',action:['start','stop','restart','restartBridge','quit'].includes(event.action)?event.action:'operation',ok:event.ok===true};
  if(event.type==='status') {
    const status=event.status||event;
    return {type:'status',...Object.fromEntries(['wsConnected','acpConnected','qqOnline'].map(key=>[key,status[key]===true])),...Object.fromEntries(['sessions','messagesIn','messagesOut','messagesDropped','pendingMessages','pendingIngress','pendingIngressBytes','ingressDropped','turns'].map(key=>[key,Number.isSafeInteger(status[key])&&status[key]>=0?status[key]:0])),hasError:Boolean(status.lastError)};
  }
  if(event.type==='error')return {type:'notice',message:'运行管理出现错误，请在本机查看详细诊断。'};
  if(event.type==='job'){
    const job=event.job||{};
    if(!/^[a-f0-9]{32}$/.test(job.id||'')||!['start','stop','restartBridge','component'].includes(job.kind))return undefined;
    const messages=['等待执行','正在执行','正在取消','已取消','操作已完成，请核对运行状态','操作未完成，请核对配置或在本机查看诊断后重试'];
    return {type:'job',job:{id:job.id,kind:job.kind,...(['dsh','napcat'].includes(job.component)?{component:job.component}:{}),state:['queued','running','succeeded','failed','cancelled'].includes(job.state)?job.state:'failed',phase:['queued','running','downloading','copying','extracting','installing','checking','ready','succeeded','failed','cancelled'].includes(job.phase)?job.phase:'failed',...Object.fromEntries(['version','createdAt','updatedAt'].map(key=>[key,Number.isSafeInteger(job[key])&&job[key]>=0?job[key]:0])),message:messages.includes(job.message)?job.message:'任务状态已更新'}};
  }
  return undefined;
}

export async function redactedConfiguration(dataRoot) {
  const {fields}=await new RuntimeConfiguration(dataRoot).read();return {fields};
}

/** 私有管理只开放回环 HTTP 和明确列出的操作。 */
export async function createManagementServer({root,dataRoot,port=18380,origin:configuredOrigin,clock=Date.now}={}) {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('管理端口无效');
  if(configuredOrigin){const url=new URL(configuredOrigin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('首轮控制台仅支持回环 HTTP，请通过 SSH 隧道访问');}
  const layout=await prepareRuntime({root,args:['--data-dir',dataRoot]});
  const auth=new OwnerAuth(layout.dataRoot,{clock});await auth.status();
  const app=Fastify({logger:false,bodyLimit:65536,requestTimeout:10000,connectionTimeout:10000,trustProxy:false,ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}});
  let origin=configuredOrigin?new URL(configuredOrigin).origin:'',latest={bridge:false,napcat:false,busy:false},sequence=0,ringBytes=0;
  const ring=[],clients=new Set();let service,jobs;
  app.decorateRequest('owner',null);
  const rates=new Map();
  const push=(client,event)=>{if(client.response.destroyed)return;if(client.response.writableLength>65536){client.response.destroy();return;}client.response.write(`id: ${event.id}\ndata: ${event.json}\n\n`);};
  const publish=raw=>{
    const event=managementEvent(raw);if(!event)return;
    if(event.type==='state'||event.type==='status')latest={...latest,...event,...(event.type==='state'&&!event.bridge?{wsConnected:false,acpConnected:false}:{}),...(event.type==='state'&&!event.napcat?{qqOnline:false}:{})};
    const json=JSON.stringify(event);if(Buffer.byteLength(json)>8192)return;
    const item={id:++sequence,json};ring.push(item);ringBytes+=Buffer.byteLength(json);
    while(ring.length>256||ringBytes>131072){ringBytes-=Buffer.byteLength(ring.shift().json);}
    for(const client of clients)push(client,item);
  };
  const closeSession=id=>{for(const client of clients)if(client.session.id===id)client.response.destroy();};
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    if(request.headers.host!==new URL(origin).host)throw new AuthError('访问地址不匹配',403);
    if(request.headers.origin&&request.headers.origin!==origin)throw new AuthError('请求来源不受信任',403);
    if(!['GET','HEAD'].includes(request.method)&&request.headers.origin!==origin)throw new AuthError('写请求缺少可信来源',403);
    const now=clock();let rate=rates.get(request.ip);if(!rate||now-rate.at>60000){rate={at:now,count:0};rates.delete(request.ip);rates.set(request.ip,rate);}if(rates.size>128)rates.delete(rates.keys().next().value);if(++rate.count>120)throw new AuthError('请求较多，请稍后重试',429);
    const path=request.url.split('?')[0];
    if(path.startsWith('/api/')&&!['/api/auth/status','/api/auth/login','/api/auth/claim'].includes(path))request.owner=await auth.verify(cookie(request));
    if(path.startsWith('/api/')&&!['GET','HEAD'].includes(request.method)&&!['/api/auth/login','/api/auth/claim'].includes(path))await auth.csrf(cookie(request),request.headers['x-csrf-token']);
  });
  app.setErrorHandler((error,request,reply)=>{
    const known=error instanceof AuthError||error instanceof ConfigurationError||error instanceof JobError;
    const status=known?error.statusCode:error.code==='BOT_RESOURCE_LOCKED'?409:error.statusCode===413?413:error.validation?400:500;
    reply.code(status).send({error:known?error.message:status===500?'管理操作暂不可用，请在本机检查配置。':status===409?'连接配置正在使用，请稍后重试。':status===413?'请求内容过大':'请求格式无效'});
  });
  app.get('/api/auth/status',async()=>auth.status());
  const authenticate=(operation,keys)=>app.post('/api/auth/'+operation,{schema:{body:strings(keys)}},async(request,reply)=>{
    const session=await auth[operation](request.body,request.ip);reply.header('set-cookie',sessionCookie(session.token));return {csrf:session.csrf,expiresAt:session.expires};
  });
  authenticate('login',['password']);authenticate('claim',['token','password']);
  app.get('/api/session',async request=>({csrf:request.owner.csrf,expiresAt:request.owner.expires}));
  app.post('/api/auth/logout',async(request,reply)=>{const session=await auth.verify(cookie(request));auth.logout(cookie(request));closeSession(session.id);reply.header('set-cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);return {ok:true};});
  app.get('/api/status',async()=>({runtime:latest,capabilities:{readOnly:false,platform:process.platform,remoteShell:false,configuration:true,runtime:true,components:process.platform==='win32'&&process.arch==='x64'}}));
  app.get('/api/config',async()=>service.readConfiguration());
  const revision={type:'string',pattern:'^[a-f0-9]{64}$'};
  app.patch('/api/config',{schema:{body:{type:'object',required:['revision','values'],additionalProperties:false,properties:{revision,values:{type:'object',minProperties:1,maxProperties:32,additionalProperties:{type:'string',maxLength:4096}}}}}},async request=>{
    if(jobs.busy)throw new JobError('请等待管理任务完成后再保存配置');
    return service.updateConfiguration(request.body);
  });
  app.put('/api/secrets/:name',{schema:{body:{oneOf:[{type:'object',required:['revision','operation','value'],additionalProperties:false,properties:{revision,operation:{const:'replace'},value:{type:'string',minLength:1,maxLength:4096}}},{type:'object',required:['revision','operation'],additionalProperties:false,properties:{revision,operation:{const:'clear'}}}]}}},async request=>{
    if(jobs.busy)throw new JobError('请等待管理任务完成后再保存密钥');
    return service.updateConfiguration({revision:request.body.revision,secret:{name:request.params.name,operation:request.body.operation,...(request.body.value!==undefined?{value:request.body.value}:{})}});
  });
  const jobBody={type:'object',required:['idempotencyKey'],additionalProperties:false,properties:{idempotencyKey:{type:'string',pattern:'^[A-Za-z0-9_-]{16,64}$'}}};
  const submit=(kind,component,request,reply)=>{const job=jobs.submit({kind,component,key:request.body.idempotencyKey,scope:request.owner.revision,credential:cookie(request)});return reply.code(202).send({job});};
  for(const action of ['start','stop','restartBridge'])app.post('/api/runtime/'+action,{schema:{body:jobBody}},async(request,reply)=>submit(action,undefined,request,reply));
  app.post('/api/components/:id/prepare',{schema:{body:jobBody}},async(request,reply)=>{
    if(!['dsh','napcat'].includes(request.params.id))throw new JobError('未知受管组件',400);
    if(process.platform!=='win32'||process.arch!=='x64')throw new JobError('此平台的受管组件尚未提供，请使用已配置的外部服务',409);
    if(latest.bridge||latest.napcat)throw new JobError('请先停止机器人，再准备组件');
    return submit('component',request.params.id,request,reply);
  });
  app.get('/api/jobs',async request=>({jobs:jobs.list(request.owner.revision)}));
  app.get('/api/jobs/:id',async request=>({job:jobs.get(request.params.id,request.owner.revision)}));
  app.post('/api/jobs/:id/cancel',{schema:{body:{type:'object',additionalProperties:false}}},async request=>({job:jobs.cancelJob(request.params.id,request.owner.revision)}));
  app.get('/api/events',{exposeHeadRoute:false},async(request,reply)=>{
    const session=request.owner;
    if([...clients].filter(client=>client.session.id===session.id).length>=2)throw new AuthError('此会话的事件连接已达上限',429);
    reply.hijack();const response=reply.raw;
    response.writeHead(200,{...reply.getHeaders(),'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
    response.write(': connected\n\n');
    const client={response,session};clients.add(client);
    const last=Number(request.headers['last-event-id']);
    if(Number.isSafeInteger(last)&&last>0&&last<=sequence&&ring[0]?.id<=last){for(const event of ring)if(event.id>last)push(client,event);}
    else push(client,{id:sequence,json:JSON.stringify({type:'snapshot',runtime:latest})});
    const timer=setInterval(async()=>{try{await auth.verify(cookie(request),{touch:false});if(response.writableLength>65536)response.destroy();else response.write(': keep-alive\n\n');}catch{response.destroy();}},10000);
    response.once('close',()=>{clearInterval(timer);clients.delete(client);});
  });
  app.get('/',async(request,reply)=>{try{return reply.type('text/html').send(await readFile(join(root,'web/dist/index.html')));}catch(error){if(error.code!=='ENOENT')throw error;return reply.code(503).send('网页资源尚未构建，请运行 npm run web:build。');}});
  app.get('/assets/:file',async(request,reply)=>{
    const file=request.params.file;if(!/^[A-Za-z0-9_.-]+\.(?:js|css|svg|woff2)$/.test(file))return reply.code(404).send({error:'资源不存在'});
    const path=join(root,'web/dist/assets',file);let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return reply.code(404).send({error:'资源不存在'});throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.size>5242880)return reply.code(404).send({error:'资源不存在'});
    reply.header('Cache-Control','public, max-age=31536000, immutable').type(file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'font/woff2');return reply.send(await readFile(path));
  });
  app.addHook('preClose',async()=>{for(const client of clients)client.response.destroy();});
  app.addHook('onClose',async()=>{await jobs?.close();auth.sessions.clear();await service?.close();});
  try {
    service=await createRuntimeService({root,layout,onEvent:event=>{jobs?.progress(event);publish(event);},onFatal:()=>app.close()});
    jobs=new ManagementJobs({clock,publish:job=>publish({type:'job',job}),validate:async(credential,scope)=>{const session=await auth.verify(credential,{touch:false});if(session.revision!==scope)throw new AuthError('主人凭据已变更');},cancel:()=>service.receive({action:'components-cancel'}),execute:async(kind,component)=>{
      const result=await service.receive(kind==='component'?{action:'components',data:{operation:'install',id:component}}:{action:kind});
      if(result?.ok===false)throw new Error('运行检查未通过');
    }});
    await app.listen({host:'127.0.0.1',port});origin||=`http://127.0.0.1:${app.server.address().port}`;
    return {app,origin,close:()=>app.close()};
  }catch(error){await app.close();throw error;}
}
