import Fastify from 'fastify';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {createRuntimeService} from '../scripts/runtime-service.mjs';
import {prepareRuntime} from '../scripts/app-paths.mjs';
import {runtimeFields} from '../desktop/runtime-fields.mjs';
import {OwnerAuth,AuthError} from './auth.mjs';

const cookieName='whale_local_session';
const cookie=request=>{const values=String(request.headers.cookie||'').split(';').map(x=>x.trim());const matched=values.filter(x=>x.startsWith(cookieName+'='));return matched.length===1?matched[0].slice(cookieName.length+1):'';};
const sessionCookie=token=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
const strings=keys=>({type:'object',required:keys,additionalProperties:false,properties:Object.fromEntries(keys.map(key=>[key,{type:'string',maxLength:key==='password'?1024:128}]))});
export function managementEvent(event) {
  if(event.type==='state')return {type:'state',bridge:Boolean(event.bridge),napcat:Boolean(event.napcat),externalNapcat:Boolean(event.externalNapcat),busy:Boolean(event.busy)};
  if(event.type==='control')return {type:'control',action:['start','stop','restart','restartBridge','quit'].includes(event.action)?event.action:'operation',ok:event.ok===true};
  if(event.type==='status') {
    const status=event.status||event;
    return {type:'status',...Object.fromEntries(['wsConnected','acpConnected','qqOnline'].map(key=>[key,status[key]===true])),...Object.fromEntries(['sessions','messagesIn','messagesOut','messagesDropped','pendingMessages','pendingIngress','pendingIngressBytes','ingressDropped','turns'].map(key=>[key,Number.isSafeInteger(status[key])&&status[key]>=0?status[key]:0])),hasError:Boolean(status.lastError)};
  }
  if(event.type==='error')return {type:'notice',message:'运行管理出现错误，请在本机查看详细诊断。'};
  return undefined;
}

export async function redactedConfiguration(dataRoot) {
  const path=join(dataRoot,'.env'),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw new Error('连接配置文件不可读取');
  const env=parseEnv(await readFile(path,'utf8'));
  const secretKey=key=>/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key),secrets=Object.entries(env).filter(([key,value])=>secretKey(key)&&value).map(([,value])=>value);
  return {fields:runtimeFields.map(([group,key,label,fallback,kind])=>{
    const value=env[key]??fallback??'';
    if(kind==='secret'||secretKey(key))return {group,key,label,kind:'secret',configured:Boolean(value)};
    let safe=String(value);
    for(const secret of secrets)safe=safe.split(secret).join('[已隐藏]');
    if(/URL$/.test(key)&&safe){try{const url=new URL(safe);url.username='';url.password='';for(const name of url.searchParams.keys())if(/token|key|secret|password/i.test(name))url.searchParams.set(name,'[已隐藏]');safe=url.href;}catch{safe='地址格式需要检查';}}
    return {group,key,label,kind:kind||'text',value:safe};
  })};
}

/** 首轮只开放回环 HTTP 与只读管理，不公开任意命令分发。 */
export async function createManagementServer({root,dataRoot,port=18380,origin:configuredOrigin,clock=Date.now}={}) {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('管理端口无效');
  if(configuredOrigin){const url=new URL(configuredOrigin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('首轮控制台仅支持回环 HTTP，请通过 SSH 隧道访问');}
  const layout=await prepareRuntime({root,args:['--data-dir',dataRoot]});
  const auth=new OwnerAuth(layout.dataRoot,{clock});await auth.status();
  const app=Fastify({logger:false,bodyLimit:65536,requestTimeout:10000,connectionTimeout:10000,trustProxy:false});
  let origin=configuredOrigin?new URL(configuredOrigin).origin:'',latest={bridge:false,napcat:false,busy:false},sequence=0,ringBytes=0;
  const ring=[],clients=new Set();let service;
  app.decorateRequest('owner',null);
  const rates=new Map();
  const push=(client,event)=>{if(client.response.destroyed)return;if(client.response.writableLength>65536){client.response.destroy();return;}client.response.write(`id: ${event.id}\ndata: ${event.json}\n\n`);};
  const publish=raw=>{
    const event=managementEvent(raw);if(!event)return;
    if(event.type==='state'||event.type==='status')latest={...latest,...event};
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
    const status=error instanceof AuthError?error.statusCode:error.statusCode===413?413:error.validation?400:500;
    reply.code(status).send({error:status===500?'管理操作暂不可用，请在本机检查配置。':error instanceof AuthError?error.message:status===413?'请求内容过大':'请求格式无效'});
  });
  app.get('/api/auth/status',async()=>auth.status());
  const authenticate=(operation,keys)=>app.post('/api/auth/'+operation,{schema:{body:strings(keys)}},async(request,reply)=>{
    const session=await auth[operation](request.body,request.ip);reply.header('set-cookie',sessionCookie(session.token));return {csrf:session.csrf,expiresAt:session.expires};
  });
  authenticate('login',['password']);authenticate('claim',['token','password']);
  app.get('/api/session',async request=>({csrf:request.owner.csrf,expiresAt:request.owner.expires}));
  app.post('/api/auth/logout',async(request,reply)=>{const session=await auth.verify(cookie(request));auth.logout(cookie(request));closeSession(session.id);reply.header('set-cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);return {ok:true};});
  app.get('/api/status',async()=>({runtime:latest,capabilities:{readOnly:true,platform:process.platform,remoteShell:false}}));
  app.get('/api/config',async()=>redactedConfiguration(layout.dataRoot));
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
  app.addHook('onClose',async()=>{auth.sessions.clear();await service?.close();});
  try {
    service=await createRuntimeService({root,layout,onEvent:publish,onFatal:()=>app.close()});
    await app.listen({host:'127.0.0.1',port});origin||=`http://127.0.0.1:${app.server.address().port}`;
    return {app,origin,close:()=>app.close()};
  }catch(error){await app.close();throw error;}
}
