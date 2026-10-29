import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,link} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {initializeWebOwner} from '../server/auth.mjs';
import {createManagementServer} from '../server/app.mjs';
import {ManagementJobs} from '../server/jobs.mjs';
import {RuntimeConfiguration} from '../scripts/runtime-configuration.mjs';
import {acquireDataResources} from '../dist/core/resource-lock.js';

async function fixture(run){
  const dataRoot=await mkdtemp(join(tmpdir(),'qq-web-management-'));let server;
  try{
    const initial=await initializeWebOwner(dataRoot);server=await createManagementServer({root:resolve('.'),dataRoot,port:0});
    const response=await server.app.inject({method:'POST',url:server.origin+'/api/auth/claim',headers:{origin:server.origin},payload:{token:initial.token,password:'fixture-only-long-management-password'}});
    assert.equal(response.statusCode,200,response.body);
    const session={cookie:response.headers['set-cookie'].split(';')[0],csrf:response.json().csrf};
    const call=(method,path,payload,headers={})=>server.app.inject({method,url:server.origin+path,headers:{origin:server.origin,cookie:session.cookie,'x-csrf-token':session.csrf,...headers},...(payload?{payload}:{})});
    await run({...server,dataRoot,call,session});
  }finally{await server?.close();await rm(dataRoot,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test('网页配置严格限制字段，原子保存保留未知配置，双页面并发只有一个版本可提交',()=>fixture(async({call,dataRoot})=>{
  await writeFile(join(dataRoot,'.env'),'BOT_CHAT_MODE=profile\nQUEUE_TOTAL=50\nCUSTOM_LOCAL_SETTING=fixture-keep\n');
  const before=(await call('GET','/api/config')).json();
  assert.match(before.revision,/^[a-f0-9]{64}$/);
  for(const values of [{BOT_DSH_BIN:'untrusted-command'},{ALLOW_EXEC:'1'},{ONEBOT_TOKEN:'should-use-secret-api'},{QUEUE_TOTAL:'0'},{BOT_CHAT_BASE_URL:'https://user:pass@example.com'}, {ONEBOT_HTTP_URL:'http://127.0.0.1?token=hidden'}]){
    assert.equal((await call('PATCH','/api/config',{revision:before.revision,values})).statusCode,400);
  }
  assert.equal((await call('PATCH','/api/config',{revision:before.revision,values:{QUEUE_TOTAL:'70'},isAdmin:true})).statusCode,400);
  assert.equal((await call('PATCH','/api/config',{revision:before.revision,values:{QUEUE_TOTAL:'70'}},{'x-csrf-token':''})).statusCode,403);
  const results=await Promise.all(['70','80'].map(value=>call('PATCH','/api/config',{revision:before.revision,values:{QUEUE_TOTAL:value}})));
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,409]);
  const text=await readFile(join(dataRoot,'.env'),'utf8');assert.match(text,/CUSTOM_LOCAL_SETTING=fixture-keep/);assert.match(text,/QUEUE_TOTAL='(?:70|80)'/);
  assert.doesNotMatch(JSON.stringify(results.map(result=>result.json())),/CUSTOM_LOCAL_SETTING|fixture-keep/);
}));

test('密钥替换和清除明确区分，错误及成功响应不回显原值，外部修改使旧修订失效',()=>fixture(async({call,dataRoot})=>{
  const file=join(dataRoot,'.env');await writeFile(file,'BOT_CHAT_MODE=profile\nONEBOT_TOKEN=fixture-old-private\n');
  const before=(await call('GET','/api/config')).json();
  const invalid=await call('PUT','/api/secrets/ONEBOT_TOKEN',{revision:before.revision,operation:'replace',value:''});assert.equal(invalid.statusCode,400);
  const saved=await call('PUT','/api/secrets/ONEBOT_TOKEN',{revision:before.revision,operation:'replace',value:'fixture-new-private'});assert.equal(saved.statusCode,200,saved.body);assert.doesNotMatch(saved.body,/fixture-(old|new)-private/);
  assert.ok(saved.json().fields.find(field=>field.key==='ONEBOT_TOKEN').configured);
  assert.equal((await call('PUT','/api/secrets/UNKNOWN',{revision:saved.json().revision,operation:'replace',value:'fixture-private'})).statusCode,400);
  await writeFile(file,(await readFile(file,'utf8'))+'\nCUSTOM_EXTERNAL=changed\n');
  const stale=await call('PUT','/api/secrets/ONEBOT_TOKEN',{revision:saved.json().revision,operation:'clear'});assert.equal(stale.statusCode,409);assert.doesNotMatch(stale.body,/fixture-new-private/);
  const current=(await call('GET','/api/config')).json();const cleared=await call('PUT','/api/secrets/ONEBOT_TOKEN',{revision:current.revision,operation:'clear'});
  assert.equal(cleared.statusCode,200);assert.equal(cleared.json().fields.find(field=>field.key==='ONEBOT_TOKEN').configured,false);assert.doesNotMatch(await readFile(file,'utf8'),/fixture-new-private/);
  await writeFile(file,'BOT_CHAT_MODE=project\nQQ_BOT_DEEPSEEK_API_KEY=fixture-required-key\n');
  const project=(await call('GET','/api/config')).json();
  const revoked=await call('PUT','/api/secrets/QQ_BOT_DEEPSEEK_API_KEY',{revision:project.revision,operation:'clear'});
  assert.equal(revoked.statusCode,200,'A required credential must still be revocable');assert.doesNotMatch(await readFile(file,'utf8'),/fixture-required-key/);
}));

test('配置共享文件锁也约束桌面写入，硬链接配置拒绝写入',async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'qq-config-guard-'));let lease;
  try{
    const file=join(dataRoot,'.env');await writeFile(file,'BOT_CHAT_MODE=profile\n');
    const configuration=new RuntimeConfiguration(dataRoot),before=await configuration.read();
    lease=await acquireDataResources([{path:file,label:'fixture'}]);
    const result=await new Promise((done,reject)=>{const child=fork(resolve('desktop/config-worker.mjs'),[],{cwd:dataRoot,silent:true,windowsHide:true});child.stderr.resume();child.stdout.resume();child.once('error',reject);child.once('message',done);child.send({action:'runtime',data:{QUEUE_TOTAL:'60'}});});
    assert.equal(result.ok,false);assert.match(result.error,/资源正在使用/);lease.release();lease=undefined;
    await link(file,join(dataRoot,'copy.env'));await assert.rejects(configuration.update({revision:before.revision,values:{QUEUE_TOTAL:'60'}}),/配置文件不可读取|硬链接/);
  }finally{lease?.release();await rm(dataRoot,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('网页运行操作返回可查询任务，重试同编号不重复执行，不提供通用命令',()=>fixture(async({call})=>{
  const body={idempotencyKey:'fixture-stop-00000001'};
  const first=await call('POST','/api/runtime/stop',body);assert.equal(first.statusCode,202,first.body);
  const repeated=await call('POST','/api/runtime/stop',body);assert.equal(repeated.json().job.id,first.json().job.id);
  assert.equal((await call('POST','/api/runtime/start',body)).statusCode,409);
  const deadline=Date.now()+3000;let job;
  do{job=(await call('GET','/api/jobs/'+first.json().job.id)).json().job;if(job.state==='succeeded')break;await new Promise(done=>setTimeout(done,10));}while(Date.now()<deadline);
  assert.equal(job.state,'succeeded');assert.doesNotMatch(JSON.stringify(job),/idempotency|credential|cookie|scope|fixture-stop/);
  assert.equal((await call('POST','/api/runtime/stop',{...body,command:'untrusted'})).statusCode,400);
  assert.equal((await call('POST','/api/runtime/shell',body)).statusCode,404);
  assert.equal((await call('POST','/api/components/other/prepare',body)).statusCode,400);
}));

test('组件取消独立于任务队列，停止请求可取消组件，重复请求与事件不泄漏凭据',async()=>{
  let release,executions=0,cancels=0;const events=[];
  const blocked=new Promise((done,reject)=>{release=()=>reject(new Error('fixture-private-error'));});
  const jobs=new ManagementJobs({execute:async kind=>{executions++;if(kind==='component')await blocked;},cancel:()=>{cancels++;release();},validate:async()=>{},publish:event=>events.push(event)});
  try{
    const args={kind:'component',component:'dsh',scope:'fixture-owner',credential:'fixture-private-credential',key:'fixture-component-001'};
    const component=jobs.submit(args);jobs.submit(args);await new Promise(done=>setImmediate(done));assert.equal(executions,1);
    assert.throws(()=>jobs.submit({...args,key:'fixture-component-002'}),/任务正在进行/);
    jobs.progress({phase:'installing',text:'fixture-private-progress'});
    const stop=jobs.submit({...args,scope:'new-owner-revision',kind:'stop',component:undefined,key:'fixture-stop-000001'});await jobs.tail;
    assert.equal(jobs.get(component.id,args.scope).state,'cancelled');assert.equal(jobs.get(stop.id,'new-owner-revision').state,'succeeded');assert.equal(cancels,1);assert.equal(executions,2);
    assert.doesNotMatch(JSON.stringify(events),/fixture-private|fixture-owner|fixture-component|credential|scope/);
    assert.throws(()=>jobs.get(stop.id,'different-owner'),/不存在/);
  }finally{await jobs.close();}
});

test('排队任务在执行前重新认证，任务历史有界，关闭不制造未处理拒绝',async()=>{
  let calls=0,valid=false;const jobs=new ManagementJobs({execute:async()=>{calls++;},cancel:()=>{},validate:async()=>{if(!valid)throw new Error('revoked');},publish:()=>{}});
  try{
    const first=jobs.submit({kind:'stop',scope:'owner',credential:'revoked',key:'fixture-revoked-0001'});await jobs.tail;assert.equal(calls,0);assert.equal(jobs.get(first.id,'owner').state,'failed');
    valid=true;
    for(let i=0;i<70;i++){jobs.submit({kind:'stop',scope:'owner',credential:'valid',key:'fixture-bounded-'+String(i).padStart(8,'0')});await jobs.tail;}
    assert.equal(jobs.list('owner').length,64);
  }finally{await jobs.close();}
});
