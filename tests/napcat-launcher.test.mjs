import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ProcessGuard} from '../scripts/process-guard.mjs';
import {specHash} from '../scripts/component-paths.mjs';

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(check){const end=Date.now()+10000;while(!await check()){assert.ok(Date.now()<end,'等待受控登录进程超时');await new Promise(done=>setTimeout(done,25));}}
async function fixture(managed,run){
  const base=await realpath(tmpdir()),directory=await mkdtemp(join(base,'qq-napcat-launcher-'));
  let guard;
  try{
    const app=join(directory,'程序 app'),data=join(directory,'独立 data'),runtime=join(data,'napcat/node-runtime');
    const component=join(data,'components/napcat/4.18.41-000000000000'),qqRoot=join(directory,'fake-qq');
    const shell=managed?join(component,'napcat'):join(data,'napcat/shell');
    const profile=managed?join(data,'napcat/qq-profile'):join(directory,'fixture-system-profile');
    const eventsPath=join(directory,'events.ndjson'),nativeStub=join(directory,'native-stub.mjs');
    const write=async(path,content)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,content);};
    for(const name of ['napcat-node.mjs','app-paths.mjs','setup.mjs','component-paths.mjs','qq-profile.mjs','qq-profile-preload.mjs','managed-entry.mjs']){
      await mkdir(join(app,'scripts'),{recursive:true});await copyFile(resolve('scripts',name),join(app,'scripts',name));
    }
    await mkdir(join(app,'desktop'),{recursive:true});await copyFile(resolve('desktop/ProcessGuard.cs'),join(app,'desktop/ProcessGuard.cs'));
    await mkdir(shell,{recursive:true});await copyFile(resolve('tests/fixtures/napcat-shell.mjs'),join(shell,'napcat.mjs'));
    const savedConfig='{"source":"runtime","heartInterval":30000}\n',session='{"state":"expired","marker":"retained"}\n';
    await write(join(runtime,'config/onebot11_10000.json'),savedConfig);
    await write(join(shell,'config/onebot11_10000.json'),'{"source":"shell"}\n');
    await write(join(profile,'fixture-session.json'),session);
    await write(join(data,'.env'),'NAPCAT_DISABLE_MULTI_PROCESS=1\nNAPCAT_DISABLE_MULTIPROCESSING=1\nNAPCAT_WORKER_PROCESS=1\n');
    let nodeVersion=process.versions.node;
    if(managed){
      const spec={version:'4.18.41',required:['node.exe','wrapper.node','package.json','config.json','napcat/napcat.mjs']};
      await write(join(app,'components/catalog.json'),JSON.stringify({formatVersion:1,platform:'win32-x64',components:{node:{},dsh:{},napcat:spec}}));
      await write(join(data,'components/active.json'),JSON.stringify({napcat:basename(component)}));
      await write(join(component,'installation.json'),JSON.stringify({specHash:specHash(spec)}));
      const node=process.env.NAPCAT_TEST_NODE?resolve(process.env.NAPCAT_TEST_NODE):process.execPath;
      const version=spawnSync(node,['--version'],{encoding:'utf8',windowsHide:true});assert.equal(version.status,0);
      nodeVersion=version.stdout.trim().replace(/^v/,'');await copyFile(node,join(component,'node.exe'));
      for(const name of ['wrapper.node','package.json','config.json'])await write(join(component,name),'{}');
    }else{
      const libraries=['avif_convert.dll','broadcast_ipc.dll','crypto.dll','ssl.dll','libglib-2.0-0.dll','libgobject-2.0-0.dll','libvips-42.dll','ncnn.dll','opencv.dll','package.json','QBar.dll','wrapper.node','LightQuic.dll','win64/SSOShareInfoHelper64.dll','win64/parent-ipc-core-x64.dll'];
      for(const name of libraries)await write(join(qqRoot,'versions/9.9.9-99999/resources/app',name),'{}');
      await write(join(qqRoot,'versions/config.json'),'{"curVersion":"9.9.9-99999"}');
      await write(join(runtime,'QQNT.dll'),'fixture-native-adapter');
    }
    await write(nativeStub,"import {resolve} from 'node:path';const original=process.dlopen;globalThis.fixtureOriginalCalls=0;process.dlopen=function(module,path,...args){if(resolve(path)!==resolve(process.env.NAPCAT_WRAPPER_PATH||'unused'))return original.call(this,module,path,...args);function Utility(){}Object.defineProperty(Utility,'getNTUserDataInfoConfig',{value:()=>{globalThis.fixtureOriginalCalls++;return process.env.FIXTURE_SYSTEM_PROFILE;}});module.exports={NodeQQNTWrapperUtil:Utility};};\n");
    const env={...process.env,BOT_DATA_DIR:data,BOT_QQ_DIR:qqRoot,BOT_NAPCAT_DIR:shell,BOT_SELF_ID:'10000',
      NAPCAT_DISABLE_MULTI_PROCESS:'1',NAPCAT_DISABLE_MULTIPROCESSING:'1',NAPCAT_WORKER_PROCESS:'1',
      NODE_OPTIONS:'--import='+pathToFileURL(nativeStub).href,FIXTURE_EXPECTED_PROFILE:profile,
      FIXTURE_SYSTEM_PROFILE:join(directory,'fixture-system-profile'),FIXTURE_EVENTS:eventsPath};
    guard=new ProcessGuard({root:app,dataRoot:data});
    const events=async()=>{try{return (await readFile(eventsPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
    const ready=async count=>{await until(async()=>(await events()).length>=count);return (await events())[count-1];};
    await run({directory,app,data,runtime,component,env,guard,profile,savedConfig,session,ready,events,nodeVersion});
  }finally{
    await guard?.close();
    const actual=await realpath(directory),rel=relative(base,actual);
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(actual).startsWith('qq-napcat-launcher-'));
    await rm(actual,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}

test('旧 QQ 启动方式恢复登录 Worker，保留原配置和过期登录材料',{skip:process.platform!=='win32',timeout:25000},()=>fixture(false,async options=>{
  const {guard,env,ready,profile,savedConfig,session,runtime}=options;
  const child=await guard.fork('scripts/napcat-node.mjs',{cwd:tmpdir(),env});child.stdout.resume();child.stderr.resume();
  const initial=await ready(1);assert.equal(initial.supervisor,child.pid);assert.notEqual(initial.pid,child.pid);
  assert.equal(initial.profile,profile);assert.equal(initial.originalCalls,1);assert.equal(initial.config,savedConfig);assert.equal(initial.session,session);
  child.send('offline');const restarted=await ready(2);
  assert.notEqual(restarted.pid,initial.pid);assert.equal(restarted.supervisor,initial.supervisor);
  assert.equal(restarted.config,savedConfig);assert.equal(restarted.session,session);await until(()=>!alive(initial.pid));
  assert.equal(await readFile(join(runtime,'config/onebot11_10000.json'),'utf8'),savedConfig);
  await guard.terminate(child);await until(()=>!alive(child.pid)&&!alive(restarted.pid));
}));

test('受管 QQ 每代 Worker 先安装目录隔离，登录失效及异常退出后保持同一实例',{skip:process.platform!=='win32',timeout:25000},()=>fixture(true,async options=>{
  const {guard,env,component,ready,profile,savedConfig,session,events,nodeVersion}=options;
  const child=await guard.fork('scripts/napcat-node.mjs',{cwd:tmpdir(),env,execPath:join(component,'node.exe')});child.stdout.resume();child.stderr.resume();
  const initial=await ready(1);child.send('offline');const restarted=await ready(2);
  await until(()=>!alive(initial.pid));child.send('crash');const recovered=await ready(3);await until(()=>!alive(restarted.pid));
  for(const event of [initial,restarted,recovered]){
    assert.equal(event.supervisor,child.pid);assert.equal(event.profile,profile);assert.equal(event.originalCalls,0);
    assert.equal(event.nodeVersion,nodeVersion);
    assert.equal(event.wrapper,join(component,'wrapper.node'));assert.equal(event.config,savedConfig);assert.equal(event.session,session);
  }
  assert.equal(new Set([initial.pid,restarted.pid,recovered.pid]).size,3);
  await new Promise(done=>setTimeout(done,100));assert.equal((await events()).length,3);
  await guard.terminate(child);await until(()=>!alive(child.pid)&&!alive(recovered.pid));
  assert.equal(await readFile(join(profile,'fixture-session.json'),'utf8'),session);
}));

test('命令行切换到受管运行库后仍隔离账号，宿主退出回收启动器及 QQ 子孙进程',{skip:process.platform!=='win32',timeout:25000},()=>fixture(true,async options=>{
  const {directory,app,data,env,ready,profile,nodeVersion}=options,hostEntry=join(directory,'host.mjs');
  // 命令行启动器等待 QQ 结束；先把模拟终端纳入保护，再启动真正的命令行入口。
  await writeFile(join(app,'scripts/terminal.mjs'),`import {spawn} from 'node:child_process';const cli=spawn(process.execPath,[${JSON.stringify(join(app,'scripts/napcat-node.mjs'))}],{env:process.env,windowsHide:true,stdio:'inherit'});process.send({type:'cli-started',pid:cli.pid});cli.once('exit',code=>process.exit(code??1));`);
  await writeFile(hostEntry,`import {ProcessGuard} from ${JSON.stringify(pathToFileURL(resolve('scripts/process-guard.mjs')).href)};const guard=new ProcessGuard({root:${JSON.stringify(app)},dataRoot:${JSON.stringify(data)}});const child=await guard.fork('scripts/terminal.mjs',{env:process.env});child.stdout.resume();child.stderr.resume();child.on('message',message=>{if(message.type==='cli-started')process.send({pid:child.pid,cli:message.pid});});setInterval(()=>{},1000);`);
  const host=fork(hostEntry,[],{env,execArgv:[],silent:true,windowsHide:true});host.stdout.resume();host.stderr.resume();let launcher,event;
  try{
    [launcher]=await Promise.race([once(host,'message'),once(host,'exit').then(()=>{throw new Error('受控宿主提前退出');})]);
    event=await ready(1);assert.notEqual(event.supervisor,launcher.cli);assert.equal(event.profile,profile);assert.equal(event.originalCalls,0);
    assert.equal(event.nodeVersion,nodeVersion);
    assert.ok([launcher.pid,launcher.cli,event.supervisor,event.pid].every(alive));
    const exited=once(host,'exit');host.kill();await exited;
    await until(()=>![launcher.pid,launcher.cli,event.supervisor,event.pid].some(alive));
  }finally{
    if(host.exitCode===null&&host.signalCode===null){const exited=once(host,'exit');host.kill();await exited;}
    // 先等待父进程保护助手完成回收，再删除临时实例。
    if(launcher)await until(()=>![launcher.pid,launcher.cli,event?.supervisor,event?.pid].filter(Boolean).some(alive));
  }
}));

test('登录 Worker 缺少绝对实例路径时在业务入口执行前拒绝启动',()=>{
  const preload=pathToFileURL(resolve('scripts/qq-profile-preload.mjs')).href;
  for(const [data,wrapper] of [[undefined,undefined],['relative-data','C:\\fixture\\wrapper.node'],[resolve('fixture-data'),'relative-wrapper.node']]){
    const env={...process.env};delete env.NODE_OPTIONS;delete env.BOT_DATA_DIR;delete env.NAPCAT_WRAPPER_PATH;
    if(data)env.BOT_DATA_DIR=data;if(wrapper)env.NAPCAT_WRAPPER_PATH=wrapper;
    const result=spawnSync(process.execPath,['--import',preload,'-e',"console.log('entry-started')"],{env,encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0);assert.match(result.stderr,/缺少绝对路径的实例配置/);assert.doesNotMatch(result.stdout,/entry-started/);
  }
});
