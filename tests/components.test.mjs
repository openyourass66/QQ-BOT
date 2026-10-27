import {copyRuntimeHost} from './helpers/runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { cp } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { zip } from './helpers/zip.mjs';
import { obtainArchive, extractZip } from '../scripts/components/archive.mjs';
import { prepareComponent, childEnvironment } from '../scripts/components/manager.mjs';
import { installedComponent } from '../scripts/component-paths.mjs';
import { verifyAcp } from '../scripts/components/acp-probe.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const spec=b=>({url:'https://nodejs.org/test.zip',size:b.length,sha256:digest(b)});
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-components-'));try{return await run(root);}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}}

test('组件清单中的依赖锁与上游许可保留固定字节摘要',async()=>{
  const catalog=JSON.parse(await readFile('components/catalog.json','utf8'));
  assert.equal(digest(await readFile('components/dsh/package-lock.json')),catalog.components.dsh.lockSha256);
  assert.equal(digest(await readFile('components/licenses/NapCat.txt')),catalog.components.napcat.licenseSha256);
});

test('组件下载校验固定大小与摘要，拒绝非官方跳转，重试不覆盖已有文件',()=>fixture(async root=>{
  const data=Buffer.from('official-fixed-package'),target=join(root,'package');
  let count=0;
  await obtainArchive(spec(data),target,{fetcher:async()=>{if(count++===0)throw new Error('temporary');return new Response(data);}});
  assert.equal(count,2);assert.deepEqual(await readFile(target),data);
  await assert.rejects(obtainArchive(spec(data),target,{fetcher:async()=>new Response('bad')}),{code:'EEXIST'});
  assert.deepEqual(await readFile(target),data);
  for(const bad of [Buffer.from('x'),Buffer.alloc(data.length,1),Buffer.alloc(data.length+1,2)])await assert.rejects(obtainArchive(spec(data),join(root,'bad'),{fetcher:async()=>new Response(bad)}),/不匹配|超过/);
  await assert.rejects(obtainArchive(spec(data),join(root,'redirect'),{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://attacker.example/file'}})}),/官方来源/);
  const local=join(root,'local.zip');await writeFile(local,data);
  await obtainArchive(spec(data),join(root,'import'),{archivePath:local});assert.deepEqual(await readFile(local),data);
}));

test('取消下载会结束流并清理本次临时包，不删除用户的本地原包',()=>fixture(async root=>{
  const abort=new AbortController();
  const stream=new ReadableStream({start(controller){controller.enqueue(Buffer.from('a'));},cancel(){}});
  const task=obtainArchive(spec(Buffer.from('ab')),join(root,'partial'),{signal:abort.signal,fetcher:async()=>new Response(stream),onProgress:()=>abort.abort()});
  await assert.rejects(task,{name:'AbortError'});assert.deepEqual(await readdir(root),[]);
}));

test('组件解压拒绝越界、链接、保留名、重复与大小写冲突，接受固定顶层目录',()=>fixture(async root=>{
  const bad=[[{name:'../escape',data:'x'}],[{name:'C:/escape',data:'x'}],[{name:'link',mode:0o120777,data:'../outside'}],[{name:'NUL.txt',data:'x'}],[{name:'file:ads',data:'x'}],[{name:'a.txt',data:'1'},{name:'A.txt',data:'2'}],[{name:'f',data:'1'},{name:'f',data:'2'}],[{name:'dir\\file',data:'x'}]];
  for(let i=0;i<bad.length;i++){const file=join(root,`${i}.zip`);await writeFile(file,zip(bad[i]));await assert.rejects(extractZip(file,join(root,`out-${i}`)));}
  const valid=join(root,'valid.zip');await writeFile(valid,zip([{name:'fixed/bin/app.js',data:'content'}]));
  await extractZip(valid,join(root,'valid'),{prefix:'fixed/'});assert.equal(await readFile(join(root,'valid/bin/app.js'),'utf8'),'content');
  await assert.rejects(extractZip(valid,join(root,'wrong'),{prefix:'different/'}),/结构/);
  await assert.rejects(extractZip(valid,join(root,'valid')),{code:'EEXIST'});
}));

test('组件解压文件数和实际解压大小有上限，取消后不再继续读取',()=>fixture(async root=>{
  const file=join(root,'input.zip');await writeFile(file,zip([{name:'a',data:'1234'},{name:'b',data:'56'}]));
  await assert.rejects(extractZip(file,join(root,'count'),{maxFiles:1}),/数量/);
  await assert.rejects(extractZip(file,join(root,'bytes'),{maxBytes:5}),/大小/);
  await assert.rejects(extractZip(file,join(root,'single'),{maxFileBytes:2}),/大小/);
  const abort=new AbortController();abort.abort();await assert.rejects(extractZip(file,join(root,'cancel'),{signal:abort.signal}),{name:'AbortError'});
}));

test('组件切换只在校验与探测成功后提交，失败/取消保留旧版本，安装互斥',()=>fixture(async root=>{
  const app=join(root,'app'),data=join(root,'data');await mkdir(join(app,'components'),{recursive:true});await mkdir(data);
  const bytes=zip([{name:'napcat/napcat.mjs',data:'fixture-code'}]);
  const catalog={formatVersion:1,platform:'win32-x64',components:{node:{version:'1',kind:'zip',required:['node.exe']},dsh:{version:'1',kind:'zip',required:['dsh.cmd']},napcat:{...spec(bytes),version:'1.0.0',name:'QQ',kind:'zip',prefix:'',required:['napcat/napcat.mjs']}}};
  await writeFile(join(app,'components/catalog.json'),JSON.stringify(catalog));
  const options={root:app,dataRoot:data,id:'napcat',catalog,platform:'win32',arch:'x64',fetcher:async()=>new Response(bytes),probe:async()=>{}};
  const first=await prepareComponent(options);const state=await readFile(join(data,'components/active.json'),'utf8');
  assert.equal((await installedComponent('napcat',data,app)).directory,first.installed.directory);
  await assert.rejects(prepareComponent({...options,probe:async()=>{throw new Error('probe-failed');}}),/probe-failed/);
  assert.equal(await readFile(join(data,'components/active.json'),'utf8'),state);
  assert.equal(await readFile(join(first.installed.directory,'napcat/napcat.mjs'),'utf8'),'fixture-code');
  const abort=new AbortController();let entered,release;
  const ready=new Promise(done=>entered=done),gate=new Promise(done=>release=done);
  const pending=prepareComponent({...options,signal:abort.signal,probe:async()=>{entered();await gate;}});await ready;
  await assert.rejects(prepareComponent(options),{code:'BOT_RESOURCE_LOCKED'});
  abort.abort();release();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(await readFile(join(data,'components/active.json'),'utf8'),state);
  assert.deepEqual(await readdir(join(data,'components/.staging')),[]);
  const next=await prepareComponent(options);assert.notEqual(next.installed.directory,first.installed.directory);
  assert.equal(next.suggestions[0].previous,join(first.installed.directory,'napcat'));
}));

test('组件子进程不继承项目密钥、DSH 会话和用户 npm 配置',()=>{
  const saved={...process.env};
  try{process.env.QQ_BOT_DEEPSEEK_API_KEY='fixture-private';process.env.DSH_SESSION_ID='fixture-session';process.env.NPM_TOKEN='fixture-token';process.env.NODE_OPTIONS='--inspect';const env=childEnvironment('C:/runtime/node.exe','C:/temporary');assert.equal(env.QQ_BOT_DEEPSEEK_API_KEY,undefined);assert.equal(env.DSH_SESSION_ID,undefined);assert.equal(env.NPM_TOKEN,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.match(env.NPM_CONFIG_USERCONFIG,/user.npmrc$/);}
  finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});

test('组件清单升级后仍识别旧受管路径供替换，修复不重置 DSH 登录目录',()=>fixture(async root=>{
  const app=join(root,'app'),data=join(root,'data');await mkdir(join(app,'components'),{recursive:true});await mkdir(data);
  const bytes=zip([{name:'dsh.cmd',data:'fixture-entry'}]);
  const catalog={formatVersion:1,platform:'win32-x64',components:{node:{version:'1'},napcat:{version:'1'},dsh:{...spec(bytes),version:'1.0.0',name:'old-build',kind:'zip',prefix:'',required:['dsh.cmd']}}};
  const file=join(app,'components/catalog.json');await writeFile(file,JSON.stringify(catalog));
  const options={root:app,dataRoot:data,id:'dsh',catalog,platform:'win32',arch:'x64',fetcher:async()=>new Response(bytes),probe:async()=>{}};
  const first=await prepareComponent(options);assert.ok(first.suggestions.some(item=>item.key==='BOT_DSH_HOME'));
  catalog.components.dsh.name='security-update';await writeFile(file,JSON.stringify(catalog));assert.equal(await installedComponent('dsh',data,app),undefined);
  const second=await prepareComponent(options);assert.equal(second.suggestions[0].previous,join(first.installed.directory,'dsh.cmd'));assert.ok(!second.suggestions.some(item=>item.key==='BOT_DSH_HOME'));
}));

test('固定内置 Node 可离线复用，不重复下载，并核对二进制摘要',()=>fixture(async root=>{
  const app=join(root,'app'),data=join(root,'data');await mkdir(join(app,'components'),{recursive:true});await mkdir(join(app,'runtime'));await mkdir(data);
  const binary=Buffer.from('trusted-node'),archive=zip([{name:'node.exe',data:'download-node'}]);
  const node={...spec(archive),version:'1.0.0',kind:'zip',prefix:'',executableSha256:digest(binary),required:['node.exe']};
  const catalog={formatVersion:1,platform:'win32-x64',components:{node,dsh:{version:'1'},napcat:{version:'1'}}};
  await writeFile(join(app,'components/catalog.json'),JSON.stringify(catalog));await writeFile(join(app,'release-manifest.json'),JSON.stringify({nodeArchiveSha256:node.sha256}));await writeFile(join(app,'runtime/node.exe'),binary);
  const options={root:app,dataRoot:data,id:'node',catalog,platform:'win32',arch:'x64',probe:async()=>{},fetcher:async()=>{throw new Error('offline-no-download');}};
  const ready=await prepareComponent(options);assert.deepEqual(await readFile(join(ready.installed.directory,'node.exe')),binary);
  await writeFile(join(app,'runtime/node.exe'),'modified');await assert.rejects(prepareComponent(options),/offline-no-download/);
  assert.deepEqual(await readFile(join(ready.installed.directory,'node.exe')),binary);
}));

test('组件 ACP 探测只初始化协议；提前退出明确失败，不发送模型提示词',()=>fixture(async root=>{
  const fake=join(root,'dsh.mjs');
  await writeFile(fake,"import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method!=='initialize')process.exit(41);console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'fixture',version:'1'}}}))});");
  await verifyAcp({node:process.execPath,entry:fake,cwd:root,env:childEnvironment(process.execPath,root),timeoutMs:3000});
  await writeFile(fake,'process.exit(42)');
  await assert.rejects(verifyAcp({node:process.execPath,entry:fake,cwd:root,env:childEnvironment(process.execPath,root),timeoutMs:3000}));
}));

test('桌面组件取消与退出不被安装队列阻塞，同批到达的取消也能生效',()=>fixture(async root=>{
  for(const dir of ['desktop','scripts'])await mkdir(join(root,dir));
  await copyRuntimeHost(root);
  for(const file of ['app-paths.mjs','setup.mjs'])await cp(resolve('scripts',file),join(root,'scripts',file));
  await writeFile(join(root,'desktop/diagnostics.mjs'),"export async function environment(){return {}};export async function diagnose(){return {ok:true,rows:[]}};export async function onebotOnline(){return false};");
  await writeFile(join(root,'desktop/component-worker.mjs'),"process.on('message',m=>{if(m.action==='cancel')process.send({type:'result',ok:false,error:'fixture-cancelled'},()=>process.disconnect());else process.send({type:'progress',id:'dsh',phase:'installing'});});");
  const child=spawn(process.execPath,[join(root,'desktop/host.mjs')],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const events=[];let errors='';child.stderr.on('data',b=>errors+=b);createInterface({input:child.stdout}).on('line',line=>events.push(JSON.parse(line)));
  const until=async check=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,errors+JSON.stringify(events));await new Promise(done=>setTimeout(done,10));}};
  try {
    child.stdin.write(JSON.stringify({action:'components',data:{operation:'install',id:'dsh'}})+'\n');
    await until(()=>events.some(e=>e.type==='component-progress'));
    child.stdin.write(JSON.stringify({action:'components-cancel'})+'\n');await until(()=>events.some(e=>e.text==='fixture-cancelled'));
    child.stdin.write(JSON.stringify({action:'components',data:{operation:'install',id:'dsh'}})+'\n'+JSON.stringify({action:'quit'})+'\n');
    const exit=await once(child,'exit');assert.equal(exit[0],0);
    assert.ok(events.some(e=>e.text==='组件准备已取消'));
  } finally {if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}}
}));

test('受管 QQ 组件使用稳定可写目录与回环管理口，不依赖系统 QQ，保留已有配置', {skip:process.platform!=='win32'},()=>fixture(async root=>{
  const app=join(root,'app'),data=join(root,'data');await mkdir(join(app,'components'),{recursive:true});await mkdir(join(app,'scripts'));await mkdir(data);
  const bytes=zip([{name:'napcat/napcat.mjs',data:"console.log(JSON.stringify({cwd:process.cwd(),node:process.execPath,wrapper:process.env.NAPCAT_WRAPPER_PATH,package:process.env.NAPCAT_QQ_PACKAGE_INFO_PATH}))"}]);
  const catalog={formatVersion:1,platform:'win32-x64',components:{node:{version:'1'},dsh:{version:'1'},napcat:{...spec(bytes),version:'1.0.0',kind:'zip',prefix:'',required:['napcat/napcat.mjs']}}};
  await writeFile(join(app,'components/catalog.json'),JSON.stringify(catalog));
  const prepared=await prepareComponent({root:app,dataRoot:data,id:'napcat',catalog,platform:'win32',arch:'x64',fetcher:async()=>new Response(bytes),probe:async()=>{}});
  await cp(process.execPath,join(prepared.installed.directory,'node.exe'));
  for(const name of ['napcat-node.mjs','app-paths.mjs','setup.mjs','component-paths.mjs','qq-profile.mjs'])await cp(resolve('scripts',name),join(app,'scripts',name));
  const execute=async()=>{const child=spawn(process.execPath,[join(app,'scripts/napcat-node.mjs')],{env:{...process.env,BOT_DATA_DIR:data,BOT_NAPCAT_DIR:join(prepared.installed.directory,'napcat'),BOT_QQ_DIR:''},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',error='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);assert.equal((await once(child,'exit'))[0],0,error);return JSON.parse(out.trim().split('\n').at(-1));};
  const result=await execute();assert.equal(result.cwd,join(data,'napcat/node-runtime'));assert.equal(result.node,join(prepared.installed.directory,'node.exe'));assert.equal(result.wrapper,join(prepared.installed.directory,'wrapper.node'));
  const config=join(data,'napcat/node-runtime/config/webui.json'),first=await readFile(config,'utf8'),parsed=JSON.parse(first);assert.equal(parsed.host,'127.0.0.1');assert.equal(parsed.token.length,48);
  await execute();assert.equal(await readFile(config,'utf8'),first);
}));
