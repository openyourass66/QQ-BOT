import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,rename,symlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ManagedQQ,matchesManagedNetwork} from '../scripts/qq-runtime.mjs';
import {specHash} from '../scripts/component-paths.mjs';
import {isolateQQWrapper,installQQProfileIsolation} from '../scripts/qq-profile.mjs';
import {resolve} from 'node:path';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'qq-login-'));
  const app=join(root,'app'),data=join(root,'data'),spec={version:'4.18.41',required:['napcat/napcat.mjs']},token='4.18.41-000000000000';
  try {
    await mkdir(join(app,'components'),{recursive:true});await mkdir(join(data,'components/napcat',token,'napcat'),{recursive:true});
    await writeFile(join(app,'components/catalog.json'),JSON.stringify({formatVersion:1,platform:'win32-x64',components:{node:{},dsh:{},napcat:spec}}));
    await writeFile(join(data,'components/active.json'),JSON.stringify({napcat:token}));
    await writeFile(join(data,'components/napcat',token,'installation.json'),JSON.stringify({specHash:specHash(spec)}));
    await writeFile(join(data,'components/napcat',token,'napcat/napcat.mjs'),'');
    return await run({root:app,dataRoot:data,shell:join(data,'components/napcat',token,'napcat')});
  } finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test('QQ 原生只读目录接口通过独立适配隔离，原方法及无关模块保持原样',()=>{
  function Utility(){};Object.defineProperty(Utility,'getNTUserDataInfoConfig',{value:()=>assert.fail('System QQ path must not be read')});
  Object.defineProperty(Utility,'other',{value:function(){return this===Utility;}});
  const exports={NodeQQNTWrapperUtil:Utility};const facade=isolateQQWrapper(exports,'.fixture-profile');
  assert.equal(facade.getNTUserDataInfoConfig(),resolve('.fixture-profile'));assert.equal(facade.other(),true);assert.notEqual(facade,Utility);assert.equal(Object.getOwnPropertyDescriptor(Utility,'getNTUserDataInfoConfig').configurable,false);
  let loaded=0;const target={dlopen(module){loaded++;module.exports={NodeQQNTWrapperUtil:Utility};}};const original=target.dlopen;
  const restore=installQQProfileIsolation('wrapper.node','.fixture-profile',target),module={};target.dlopen(module,'other.node');assert.equal(module.exports.NodeQQNTWrapperUtil,Utility);
  target.dlopen(module,'wrapper.node');assert.equal(module.exports.NodeQQNTWrapperUtil.getNTUserDataInfoConfig(),resolve('.fixture-profile'));assert.equal(loaded,2);restore();assert.equal(target.dlopen,original);
  assert.throws(()=>isolateQQWrapper({},'.fixture-profile'),/不支持/);
});

test('受管 QQ 首次准备生成隔离端口和随机令牌，不保存项目草稿，重复准备保留配置',()=>fixture(async options=>{
  const qq=new ManagedQQ(options);
  assert.equal((await qq.status()).phase,'setup_required');
  await writeFile(join(options.dataRoot,'.env'),'KEEP=original\n');
  const result=await qq.prepare(options.shell),metadata=await qq.metadata();
  assert.equal(result.operation,'prepare');assert.equal(metadata.token.length,64);
  assert.equal(new Set([metadata.httpPort,metadata.wsPort,metadata.webuiPort]).size,3);
  const config=JSON.parse(await readFile(join(qq.runtime,'config/onebot11.json'),'utf8'));
  assert.equal(matchesManagedNetwork(config,metadata),true);assert.equal(config.network.httpServers[0].enableCors,false);
  assert.equal(await readFile(join(options.dataRoot,'.env'),'utf8'),'KEEP=original\n');
  const first=await readFile(join(qq.runtime,'config/webui.json'),'utf8');await qq.prepare(options.shell);
  assert.equal(await readFile(join(qq.runtime,'config/webui.json'),'utf8'),first);
  assert.equal((await qq.connection(options.shell)).suggestions.ONEBOT_TOKEN,metadata.token);
  config.network.httpServers[0].host='0.0.0.0';assert.equal(matchesManagedNetwork(config,metadata),false);
  await writeFile(join(qq.runtime,'config/onebot11.json'),JSON.stringify(config));await assert.rejects(qq.prepare(options.shell),/已改变/);
}));

test('已有手工配置及自定义 QQ 路径不被自动准备覆盖',()=>fixture(async options=>{
  const qq=new ManagedQQ(options);await assert.rejects(qq.prepare('other/shell'),/自定义/);
  await mkdir(join(qq.runtime,'config'),{recursive:true});const path=join(qq.runtime,'config/webui.json');await writeFile(path,'original-personal-config');
  await assert.rejects(qq.prepare(options.shell),/手工/);assert.equal(await readFile(path,'utf8'),'original-personal-config');
  assert.deepEqual(await readdir(join(qq.runtime,'config')),['webui.json']);
}));

test('受管 QQ 按实际目录识别组件别名，拒绝不同目录',()=>fixture(async options=>{
  const alias=join(options.root,'组件 alias');
  await symlink(options.shell,alias,process.platform==='win32'?'junction':'dir');
  try{
    const qq=new ManagedQQ(options);
    assert.equal((await qq.prepare(alias)).phase,'starting');
    await assert.rejects(qq.selected(join(options.root,'other-shell')),/自定义/);
  }finally{await rm(alias,{recursive:process.platform==='win32'});}
}));

test('中断的 QQ 准备仅恢复摘要相符的自有文件，不覆盖新修改，已占用端口不重复启动',()=>fixture(async options=>{
  const qq=new ManagedQQ(options);await qq.prepare(options.shell);
  const marker=join(qq.runtime,'managed-connection.json'),pending=join(qq.runtime,'managed-connection.pending.json');
  const original=await qq.metadata();await rename(marker,pending);await qq.prepare(options.shell);
  assert.notEqual((await qq.metadata()).token,original.token);
  const server=createServer(),port=(await qq.metadata()).httpPort;await new Promise(done=>server.listen(port,'127.0.0.1',done));
  try {await assert.rejects(qq.prepare(options.shell),/端口已被占用/);} finally {await new Promise(done=>server.close(done));}
  await rename(marker,pending);const config=join(qq.runtime,'config/onebot11.json');await writeFile(config,'{"personal":"changed"}');
  await assert.rejects(qq.prepare(options.shell),/新修改/);assert.equal(await readFile(config,'utf8'),'{"personal":"changed"}');
}));

test('QQ 登录适配缓存认证、支持令牌轮换，二维码不落盘、不获取外部地址，状态不泄露凭据',()=>fixture(async options=>{
  let logins=0,encodes=0,refreshes=0,phase='waiting_qrcode',qr='https://qq.com/fixture-only';
  const qq=new ManagedQQ({...options,encodeQr:async value=>{encodes++;assert.equal(value,qr);return 'data:image/png;base64,fixture';},fetcher:async(input,request)=>{
    const url=new URL(input);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.search,'');assert.equal(request.redirect,'error');
    let data;
    if(url.pathname==='/api/auth/login') {logins++;const config=JSON.parse(await readFile(join(qq.runtime,'config/webui.json'),'utf8'));assert.equal(JSON.parse(request.body).hash,createHash('sha256').update(config.token+'.napcat').digest('hex'));data={Credential:'fixture-session-credential'};}
    else {
      assert.equal(request.headers.authorization,'Bearer fixture-session-credential');
      if(url.pathname.endsWith('CheckLoginStatus'))data={isLogin:phase==='ready',coreReady:phase==='ready',isOffline:false,loginPhase:phase,qrcodeurl:qr,loginError:null};
      else if(url.pathname.endsWith('GetQQLoginInfo'))data={uin:'10001',nick:'fixture'};
      else if(url.pathname.endsWith('GetConfig'))data=JSON.parse(await readFile(join(qq.runtime,'config/onebot11.json'),'utf8'));
      else if(url.pathname.endsWith('RefreshQRcode')){refreshes++;data={};}
      else assert.fail('Unexpected route: '+url.pathname);
    }
    return new Response(JSON.stringify({code:0,data}));
  }});
  await qq.prepare(options.shell);
  let result=await qq.status();assert.match(result.qrImage,/^data:image\/png/);await qq.status();assert.equal(logins,1);assert.equal(encodes,1);
  assert.doesNotMatch(JSON.stringify(result),/fixture-session-credential|qq.com|webuiPort|token/);
  await qq.status({refresh:true});assert.equal(refreshes,1);assert.equal(encodes,2);
  phase='qrcode_scanned';assert.equal((await qq.status()).qrImage,undefined);
  phase='ready';result=await qq.status();assert.equal(result.networkReady,true);assert.equal(result.account,'10001');assert.equal(result.qrImage,undefined);
  const path=join(qq.runtime,'config/webui.json'),config=JSON.parse(await readFile(path,'utf8'));config.token='changed-token-with-enough-entropy-for-fixture';await writeFile(path,JSON.stringify(config));
  await qq.status();assert.equal(logins,2);
}));

test('QQ 管理拒绝非回环配置、越界响应和非官方二维码，不转发上游敏感错误',()=>fixture(async options=>{
  let mode='qr';const qq=new ManagedQQ({...options,fetcher:async url=>{
    const data=String(url).endsWith('/auth/login')?{Credential:'fixture-private-credential'}:{isLogin:false,loginPhase:'waiting_qrcode',qrcodeurl:'https://attacker.example/scan'};
    if(mode==='large')return new Response('x'.repeat(65537));
    if(mode==='error')return new Response(JSON.stringify({code:1,message:'fixture-private-credential'}));
    return new Response(JSON.stringify({code:0,data}));
  }});await qq.prepare(options.shell);
  await assert.rejects(qq.status(),/非官方/);
  mode='large';await assert.rejects(qq.status(),/过大/);
  mode='error';await assert.rejects(qq.status(),error=>/拒绝/.test(error.message)&&!error.message.includes('fixture-private-credential'));
  const path=join(qq.runtime,'config/webui.json'),config=JSON.parse(await readFile(path,'utf8'));config.host='0.0.0.0';await writeFile(path,JSON.stringify(config));await assert.rejects(qq.status(),/配置已改变/);
  await assert.rejects(qq.request('/Debug/terminal'),/不支持/);
}));

test('手工部署的本机 QQ 无需受管组件即可扫码、刷新和查看登录，保持原配置',()=>fixture(async options=>{
  await rm(join(options.dataRoot,'components/active.json'));
  const directory=join(options.dataRoot,'napcat/node-runtime/config');await mkdir(directory,{recursive:true});
  const file=join(directory,'webui.json'),original=JSON.stringify({host:'::',port:6099,token:'legacy-token'});await writeFile(file,original);
  let phase='waiting_qrcode',refreshes=0,calls=0;
  const qq=new ManagedQQ({...options,encodeQr:async()=> 'data:image/png;base64,fixture',fetcher:async(input,request)=>{
    calls++;const url=new URL(input);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'6099');assert.equal(request.redirect,'error');
    let data;
    if(url.pathname.endsWith('/auth/login'))data={Credential:'fixture-session'};
    else if(url.pathname.endsWith('/CheckLoginStatus'))data={isLogin:phase==='ready',coreReady:phase==='ready',loginPhase:phase,qrcodeurl:'https://qq.com/fixture-only'};
    else if(url.pathname.endsWith('/RefreshQRcode')){refreshes++;data={};}
    else if(url.pathname.endsWith('/GetQQLoginInfo'))data={uin:'10001'};
    else assert.fail('Unexpected route: '+url.pathname);
    return new Response(JSON.stringify({code:0,data}));
  }});
  assert.equal(await qq.existingConfiguration(),true);
  let result=await qq.status();assert.equal(result.managed,false);assert.match(result.qrImage,/^data:image\/png/);assert.equal((await qq.status({refresh:true})).phase,'waiting_qrcode');assert.equal(refreshes,1);
  phase='ready';result=await qq.status();assert.equal(result.account,'10001');assert.equal(result.networkReady,false);assert.match(result.message,/现有 OneBot/);
  const before=calls;result=await qq.status({mode:'external',refresh:true});assert.equal(result.phase,'external');assert.equal(calls,before);
  assert.equal(await readFile(file,'utf8'),original);assert.deepEqual(await readdir(directory),['webui.json']);
}));

test('手工 QQ 未启动时提供现有配置启动入口，拒绝远程管理地址与无效端口',()=>fixture(async options=>{
  const directory=join(options.dataRoot,'napcat/node-runtime/config');await mkdir(directory,{recursive:true});
  const file=join(directory,'webui.json'),config={host:'localhost',port:6099,token:'fixture-token'};await writeFile(file,JSON.stringify(config));
  let calls=0;const qq=new ManagedQQ({...options,fetcher:async()=>{calls++;throw new Error('fixture-sensitive-error');}});
  const result=await qq.status();assert.equal(result.phase,'stopped');assert.equal(result.managed,false);assert.doesNotMatch(result.message,/fixture-sensitive/);
  const before=calls;
  for(const invalid of [{host:'example.com'},{port:0},{port:65536},{port:'6099'},{enable2FA:true},{token:''}]){
    await writeFile(file,JSON.stringify({...config,...invalid}));await assert.rejects(qq.status(),/配置已改变/);
  }
  assert.equal(calls,before);
}));
