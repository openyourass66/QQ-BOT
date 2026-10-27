import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWebOwner} from '../server/auth.mjs';
import {createManagementServer,managementEvent} from '../server/app.mjs';

async function fixture(run) {
  const dataRoot=await mkdtemp(join(tmpdir(),'qq-web-server-'));let server;
  try {const initial=await initializeWebOwner(dataRoot);server=await createManagementServer({root:resolve('.'),dataRoot,port:0});await run({...server,dataRoot,initial});}
  finally{await server?.close();await rm(dataRoot,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
const password='fixture-only-strong-owner-password';
async function claim(server) {const response=await server.app.inject({method:'POST',url:server.origin+'/api/auth/claim',headers:{origin:server.origin},payload:{token:server.initial.token,password}});assert.equal(response.statusCode,200,response.body);const cookie=response.headers['set-cookie'].split(';')[0];return {cookie,csrf:response.json().csrf};}

test('Web 入口拒绝未认证、恶意 Host/Origin 及超大请求，只返回脱敏配置',()=>fixture(async server=>{
  const {app,origin,dataRoot}=server;
  assert.equal((await app.inject({url:origin+'/api/config'})).statusCode,401);
  assert.equal((await app.inject({url:origin+'/api/auth/status',headers:{host:'attacker.example'}})).statusCode,403);
  assert.equal((await app.inject({url:origin+'/api/auth/status',headers:{origin:'https://attacker.example'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:origin+'/api/auth/login',payload:{password}})).statusCode,403);
  const session=await claim(server);
  await writeFile(join(dataRoot,'.env'),'ONEBOT_TOKEN=fixture-private-qq-token\nQQ_BOT_DEEPSEEK_API_KEY=fixture-private-model-key\nONEBOT_HTTP_URL=http://user:password@127.0.0.1:3000?access_token=fixture-private-qq-token\n');
  const response=await app.inject({url:origin+'/api/config',headers:{cookie:session.cookie}});assert.equal(response.statusCode,200);assert.doesNotMatch(response.body,/fixture-private|user:password|"env"/);
  assert.ok(response.json().fields.find(field=>field.key==='ONEBOT_TOKEN').configured);
  assert.match(response.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(response.headers['cache-control'],'no-store');
  assert.equal((await app.inject({method:'POST',url:origin+'/api/auth/login',headers:{origin},payload:{password:'x'.repeat(65537)}})).statusCode,413);
  assert.equal((await app.inject({method:'POST',url:origin+'/api/commands',headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf},payload:{action:'shell'}})).statusCode,404);
}));

test('网页登录 Cookie 受限，CSRF 必须匹配，退出及本机凭据重置撤销旧会话',()=>fixture(async server=>{
  const {app,origin}=server,session=await claim(server);
  const login=await app.inject({method:'POST',url:origin+'/api/auth/login',headers:{origin},payload:{password}});assert.equal(login.statusCode,200);assert.match(login.headers['set-cookie'],/HttpOnly; SameSite=Strict; Path=\//);assert.doesNotMatch(login.body,/whale_local_session|token/);
  assert.equal((await app.inject({method:'POST',url:origin+'/api/auth/logout',headers:{origin,cookie:session.cookie}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:origin+'/api/auth/logout',headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf}})).statusCode,200);
  assert.equal((await app.inject({url:origin+'/api/status',headers:{cookie:session.cookie}})).statusCode,401);
  const secondCookie=login.headers['set-cookie'].split(';')[0];await initializeWebOwner(server.dataRoot,{reset:true});
  assert.equal((await app.inject({url:origin+'/api/status',headers:{cookie:secondCookie}})).statusCode,401);
}));

test('Web 事件按允许字段序列化，SSE 连接限额并在退出时断开，关闭服务不会等待长连接',()=>fixture(async server=>{
  const {app,origin}=server,session=await claim(server);
  assert.equal(managementEvent({type:'config',env:'fixture-private'}),undefined);
  assert.doesNotMatch(JSON.stringify(managementEvent({type:'state',bridge:true,paths:{dataRoot:'fixture-private'}})),/fixture-private|paths/);
  assert.doesNotMatch(JSON.stringify(managementEvent({type:'status',lastError:'fixture-private-token',model:'fixture-private-model'})),/fixture-private/);
  const connections=[];
  try {
    for(let i=0;i<2;i++){const response=await fetch(origin+'/api/events',{headers:{cookie:session.cookie}});assert.equal(response.status,200);connections.push(response.body.getReader());}
    const third=await fetch(origin+'/api/events',{headers:{cookie:session.cookie}});assert.equal(third.status,429);await third.body.cancel();
    const first=await connections[0].read();assert.match(new TextDecoder().decode(first.value),/connected|snapshot/);
    await app.inject({method:'POST',url:origin+'/api/auth/logout',headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf}});
    for(const reader of connections){await reader.cancel().catch(()=>{});}connections.length=0;
    const logged=await app.inject({method:'POST',url:origin+'/api/auth/login',headers:{origin},payload:{password}});const cookie=logged.headers['set-cookie'].split(';')[0];
    const response=await fetch(origin+'/api/events',{headers:{cookie}});connections.push(response.body.getReader());await server.close();
  } finally{for(const reader of connections)await reader.cancel().catch(()=>{});}
}));

test('私有控制台不接受公网来源配置',async()=>{
  for(const origin of ['http://0.0.0.0:18380','http://attacker.example','https://example.com'])await assert.rejects(createManagementServer({root:resolve('.'),dataRoot:tmpdir(),origin}),/仅支持回环/);
});
