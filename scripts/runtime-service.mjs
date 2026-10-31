import { resolve, join } from 'node:path';
import { mkdirSync, appendFileSync, existsSync, statSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { diagnose, environment, onebotOnline } from '../desktop/diagnostics.mjs';
import { acquireRuntimeLease } from './runtime-lease.mjs';
import { RuntimeConfiguration } from './runtime-configuration.mjs';
import { ProcessGuard } from './process-guard.mjs';
import { ProcessSupervisor } from './supervisor.mjs';
import { consumeLines } from './bounded-lines.mjs';
import { sameRuntimePath,assertNoPendingRestore,maintenancePending,pendingMaintenanceKind } from './app-paths.mjs';
import { classifyRuntimeFailure } from '../dist/core/runtime-failure.js';

export const runtimeActions=new Set(["maintenance","maintenance-cancel","qq-login","components","components-cancel","onboarding","model","qzone-check","knowledge","social","memory","settings-status","load","settings","env","runtime","connection","persona","diagnose","start","restart","restartBridge","stop","quit"]);
export async function createRuntimeService({root,layout,onEvent,onFatal=()=>{}}) {
const lease=await acquireRuntimeLease(root,layout.dataRoot);
let processGuard;
try {
const dataRoot = layout.dataRoot;
processGuard=new ProcessGuard({root,dataRoot});
const protectedCredentials=process.platform==='win32'&&['installed','portable'].includes(layout.mode);
const configuration = new RuntimeConfiguration(dataRoot,{protectedCredentials});
const logDir = layout.logDir; mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, 'console.log');
const children = new Map();
const desired=new Set(),launchPlans=new Map(),expectedExits=new WeakSet(),failures=new WeakMap(),configWorkers=new Set();
let supervisor,lastBridgeStatus;
const socialRequests = new Map();
let socialSequence = 0;
let busy = false, quitting = false, externalNapcat = false;
let componentWorker;
let maintenanceWorker,maintenanceCancelRequested=false,maintenanceQueued=false;
let componentCancelEpoch=0;
let qqController;
async function qqLogin(data) {
  if (!data || !['prepare','status','refresh','connection'].includes(data.operation) || Object.keys(data).some(key=>!['operation','shell','mode'].includes(key))) throw new Error('QQ 登录操作参数无效');
  if (!qqController) { const {ManagedQQ}=await import('../scripts/qq-runtime.mjs');qqController=new ManagedQQ({root,dataRoot}); }
  if(data.operation==='connection') {emit({type:'qq-login',...await qqController.connection(data.shell)});return;}
  if(data.operation==='prepare') {
    if(children.has('bridge')||children.has('napcat'))throw new Error('请先停止机器人，再创建 QQ 连接；已运行时可直接查看登录状态');
    if(data.mode==='external')throw new Error('当前使用外部 QQ 服务，请在原服务中完成登录');
    if(await qqController.existingConfiguration()) {
      await launch('napcat','scripts/napcat-node.mjs',{BOT_NAPCAT_DIR:data.shell});
      emit({type:'qq-login',operation:'prepare',phase:'starting',managed:false,message:'正在使用已有配置启动 QQ，请稍候扫码。'});state();return;
    }
    const result=await config('qq-prepare',{shell:data.shell});
    await launch('napcat','scripts/napcat-node.mjs',{BOT_NAPCAT_DIR:result.suggestions.BOT_NAPCAT_DIR});
    emit({type:'qq-login',...result});state();return;
  }
  try {emit({type:'qq-login',...await qqController.status({refresh:data.operation==='refresh',mode:data.mode})});}
  catch(error) {emit({type:'qq-login',operation:data.operation,phase:'needs_attention',message:error.message});}
}
async function components(operation, data) {
  if (componentWorker) throw new Error('组件准备正在进行，请等待完成或取消');
  if (operation === 'install' && (children.has('bridge') || children.has('napcat'))) throw new Error('请先停止机器人，再准备或修复组件');
  const epoch=componentCancelEpoch;
  const worker = await processGuard.fork('desktop/component-worker.mjs',{cwd:dataRoot});
  if(epoch!==componentCancelEpoch){await processGuard.terminate(worker);throw new Error('组件准备已取消');}
  return new Promise((done,reject)=>{
    componentWorker = worker;
    let replied = false;
    worker.on('message',message=>{
      if(message?.type==='progress')emit({...message,type:'component-progress'});
      if(message?.type==='result'){replied=true;componentWorker=undefined;message.ok?done(message.result):reject(new Error(message.error));}
    });
    worker.once('error',error=>{componentWorker=undefined;reject(error);});
    worker.once('exit',()=>{if(componentWorker===worker)componentWorker=undefined;if(!replied)reject(new Error('组件管理进程已退出，请重试'));});
    worker.send({action:operation,data});
  });
}
let secrets = [];
async function refreshSecrets() { const env = await environment(dataRoot,{allowUnavailable:true}); secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && value?.length >= 4).flatMap(([, value]) => [value,...value.split(/\r?\n/).filter(part=>part.length>=4)]); }
await refreshSecrets();
const redact = text => {
  for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
  return text.replace(/(token|password|secret)([=:\s]+)[^\s,"}]+/gi, '$1$2[已隐藏]');
};
const emit = event => {
  if (event.text) event.text = redact(event.text);
  if (['log', 'error'].includes(event.type)) {
    event.time ||= new Date().toISOString();
    try {
      if (existsSync(logPath) && statSync(logPath).size > 2_000_000) { rmSync(logPath + '.previous', { force: true }); renameSync(logPath, logPath + '.previous'); }
      appendFileSync(logPath, `${event.time} ${event.text}\n`, 'utf8');
    } catch { /* A logging failure must not stop managed processes. */ }
  }
  onEvent(event);
};
const state = () => {
  const supervision=supervisor?.snapshot()??{},phases=Object.values(supervision).map(item=>item.phase);
  const phase=phases.includes('needs_attention')?'needs_attention':phases.includes('recovering')?'recovering':supervision.bridge?.phase==='ready'?'ready':phases.includes('waiting_login')?'waiting_login':phases.includes('connecting')?'connecting':'stopped';
  emit({ type: 'state', bridge: children.has('bridge'), napcat: children.has('napcat') || externalNapcat, externalNapcat, busy, maintenance:Boolean(maintenanceWorker),recoveryPending:maintenancePending(dataRoot),recoveryKind:pendingMaintenanceKind(dataRoot)??null,paths: layout,phase,supervision });
};
supervisor=new ProcessSupervisor({onChange:()=>state(),recover:async name=>{
  const task=queue.then(async()=>{if(closing||quitting||!lease.held||!desired.has(name)){supervisor.stopped(name);return;}if(children.has(name))return;const plan=launchPlans.get(name);if(!plan)throw new Error('缺少受管启动配置');await launch(name,plan.script,plan.overrides,true);});
  queue=task.catch(()=>{});return task;
}});
async function launch(name, script, overrides = {}, recovering=false) {
  assertNoPendingRestore(dataRoot);
  desired.add(name);launchPlans.set(name,{script,overrides});supervisor.starting(name,{manual:!recovering,waitingLogin:name==='napcat'});
  try {
  if(!lease.held)throw new Error('运行管理实例锁已失效');
  if(closing)throw new Error('运行管理服务正在关闭');
  const env = { ...await environment(dataRoot), ...overrides };
  if(name==='napcat')for(const key of ['QQ_BOT_DEEPSEEK_API_KEY','BOT_MEDIA_API_KEY','BOT_LEARNING_API_KEY'])delete env[key];
  env.BOT_DATA_DIR = dataRoot;
  let execPath = process.execPath;
  if (name === 'napcat') {
    const { installedComponent, napcatShellDirectory } = await import('../scripts/component-paths.mjs');
    const managed = await installedComponent('napcat',dataRoot,root);
    if (managed && await sameRuntimePath(resolve(dataRoot,env.BOT_NAPCAT_DIR || 'napcat/shell'),napcatShellDirectory(managed))) execPath = process.platform === 'win32' ? join(managed.directory,'node.exe') : execPath;
  }
  const child = await processGuard.fork(script,{cwd:dataRoot,env,execPath});
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    consumeLines(stream, text => {
      text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 8000);
      if(name==='napcat'&&/二维码解码URL|WebUi Token|User Panel Url|[?&](?:token|k)=|[\u2580-\u259f]/i.test(text))text='QQ 登录凭据已隐藏，请在登录窗口操作。';
      emit({ type: 'log', source: name, text: `[${name}] ${text}` });
      if (/EPERM.*cordis\.yml/.test(text)) emit({ type: 'error', text: 'DSH 无法写入 Profile 的 cordis.yml。请关闭占用该文件的程序、检查文件访问权限，再点击“重连模型”。NapCat 会继续保持登录。' });
    });
  }
  child.on('message', message => {
    if (name !== 'bridge') return;
    if (message?.type === 'fatal'){failures.set(child,message.failure);return;}
    if (message?.type === 'status'&&!expectedExits.has(child)&&children.get(name)===child) {lastBridgeStatus=message;supervisor.status('bridge',{ready:message.acpConnected&&message.qqOnline&&message.wsConnected,waitingLogin:message.acpConnected&&!message.qqOnline});if(children.has('napcat'))supervisor.status('napcat',{ready:message.qqOnline,waitingLogin:!message.qqOnline});emit(message);}
    if (message?.type === 'social-result') { const pending = socialRequests.get(message.id); if (pending) { socialRequests.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.done(message.result); } }
  });
  child.on('error', error => emit({ type: 'error', text: `${name} 启动失败：${error.code || error.message}` }));
  child.once('close', (code, signal) => {
    if(children.get(name)!==child)return;children.delete(name);
    const failure=failures.get(child)??classifyRuntimeFailure(undefined);
    emit({type:expectedExits.has(child)?'log':'error',text:`[${name}] 已退出，代码 ${code??signal}${!expectedExits.has(child)&&!failure.recoverable?'：'+failure.message:''}`});
    if(name==='bridge'){
      for(const request of socialRequests.values()){clearTimeout(request.timer);request.reject(new Error('桥接已退出，请等待恢复后重试'));}socialRequests.clear();
      if(lastBridgeStatus)emit({...lastBridgeStatus,acpConnected:false,wsConnected:false});
    }
    if(expectedExits.has(child)||closing||!desired.has(name))supervisor.stopped(name);else supervisor.exited(name,failure);state();
  });
  }catch(error){error.runtimeComponent=name;throw error;}
}
async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await processGuard.terminate(child);
}
async function stopOne(name) {
  desired.delete(name);supervisor.stopped(name);
  const child = children.get(name); if (!child) return;
  expectedExits.add(child);
  if (name === 'bridge' && child.connected) child.send('shutdown', () => {});
  else await killTree(child);
  await new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const timer = setTimeout(done, 7000); child.once('close', () => { clearTimeout(timer); done(); });
  });
  await killTree(child);
  if(children.get(name)===child)children.delete(name);
}
async function stop() { await stopOne('bridge'); await stopOne('napcat'); externalNapcat = false; }
async function config(action, data) {
  const worker=await processGuard.fork('desktop/config-worker.mjs',{cwd:dataRoot,env:{...process.env,BOT_CREDENTIAL_MODE:protectedCredentials?'dpapi':'compatible',BOT_CONFIG_PROGRESS:'1'}});
  if(closing){await processGuard.terminate(worker);throw new Error('运行管理服务正在关闭');}
  configWorkers.add(worker);worker.once('exit',()=>configWorkers.delete(worker));
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => { void processGuard.terminate(worker); reject(new Error('配置操作超时，请重试')); }, action === 'social' ? 120000 : action === 'qzone-check' ? 30000 : action === 'model' ? 25000 : 10000);
    let replied = false;
    worker.on('message', result => { if(result?.type==='storage-progress'){emit(result);return;}if(replied)return;replied = true; clearTimeout(timeout); result.ok ? done(result.result) : reject(new Error(result.error)); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', () => { clearTimeout(timeout); if (!replied) reject(new Error('配置读取失败，请检查构建文件与配置格式')); });
    worker.send({ action, data });
  });
}
async function check() {
  const env = await environment(dataRoot);
  const external = env.BOT_ONEBOT_MODE === 'external' || env.BOT_ONEBOT_MODE !== 'managed' && await onebotOnline(dataRoot);
  const result = await diagnose(root, { dataRoot, externalOnebot: children.has('napcat') || external });
  emit({ type: 'diagnostics', ...result }); return result;
}
async function command({ action, data }) {
  if(!lease.held)throw new Error('运行管理实例锁已失效');
  if(!['maintenance','load','diagnose','stop','quit'].includes(action))assertNoPendingRestore(dataRoot);
  if(action==='maintenance'){
    if(data?.operation==='status'){emit({type:'maintenance',operation:'status',recoveryPending:maintenancePending(dataRoot)});return;}
    if(children.size||componentWorker||configWorkers.size||desired.size)throw new Error('请先停止机器人和受管 QQ，并等待其它操作结束，再进行备份或恢复。');
    if(!['backup','verify','restore','migrate','recover','diagnostic','cleanup-preview','cleanup'].includes(data?.operation))throw new Error('未知维护操作。');
    busy=true;state();
    try{
      if(maintenanceCancelRequested)throw new Error('维护已取消，未开始操作数据。');
      const worker=await processGuard.fork('desktop/maintenance-worker.mjs',{cwd:dataRoot,env:{...process.env,BOT_DATA_DIR:dataRoot}});maintenanceWorker=worker;state();
      worker.stdout.resume();worker.stderr.resume();
      const result=await new Promise((done,reject)=>{
        let replied=false;const timer=setTimeout(()=>{void processGuard.terminate(worker).finally(()=>finish(new Error('维护操作超时，若存在恢复中断请先处理再启动。')));},1800000);
        const finish=(error,value)=>{if(replied)return;replied=true;clearTimeout(timer);error?reject(error):done(value);};
        worker.on('message',message=>{if(message?.type==='maintenance-progress'){emit(message);return;}if(message?.ok===true)finish(undefined,message.result);else if(message?.ok===false)finish(Object.assign(new Error(message.error),{code:message.code}));});
        worker.once('error',()=>finish(new Error('维护进程无法启动。')));worker.once('exit',()=>finish(new Error('维护进程已退出；如有恢复中断请先处理再启动。')));
        worker.send({data},error=>{if(error)finish(new Error('维护请求提交失败。'));});if(maintenanceCancelRequested)worker.send({action:'cancel'},()=>{});
      });
      emit({type:'maintenance',...result});return result;
    }finally{maintenanceWorker=undefined;maintenanceCancelRequested=false;busy=false;state();}
  }
  if (action === 'qq-login') { await qqLogin(data); return; }
  if (action === 'components') { const result = await components(data?.operation, data?.id ? {id:data.id,...(data.archivePath?{archivePath:data.archivePath}:{})} : {}); emit({type:'components',...result}); return; }
  if (action === 'onboarding') { const result = await config(action, data); emit({ type: 'onboarding', ...result }); return; }
  if (action === 'model') { const result = await config(action, data); emit({ type: 'model', ...result }); return; }
  if (action === 'qzone-check') { const result = await config(action,data);emit({type:'qzone-check',...result});return; }
  if (action === 'knowledge') { const result = await config(action, data); emit({ type: 'knowledge', ...result }); return; }
  if (action === 'social' || action === 'memory' || action === 'settings-status') {
    if (action === 'memory') data = { ...data, section: data?.section==='lexicon'?'lexicon':'memories' };
    if (action === 'settings-status') data = { op: 'list', section: 'contacts' };
    const bridge = children.get('bridge');
    let result;
    if (bridge?.connected) result = await new Promise((done, reject) => {
      const id = String(++socialSequence);
      const timer = setTimeout(() => { socialRequests.delete(id); reject(new Error('QQ 活动操作超时，请确认机器人运行状态')); }, data?.op==='review_memory'?60000:30000);
      socialRequests.set(id, { done, reject, timer });
      bridge.send({ type: 'social', id, data }, error => { if (error) { clearTimeout(timer); socialRequests.delete(id); reject(error); } });
    });
    else result = await config('social', data);
    emit({ type: action === 'settings-status' ? 'settings-status' : action === 'memory' ? 'memory' : 'social', ...result }); return;
  }
  if (action === 'load' || ['settings', 'env', 'runtime', 'connection', 'persona'].includes(action)) {
    const result = await config(action, data);
    const restartRequested = action === 'connection' && data.restart === true;
    emit(action === 'load' ? { type: 'config', ...result } : { type: 'saved', section: action, result, restartRequested });
    await refreshSecrets();
    if (restartRequested) await command({ action: result.restartAction === 'restartBridge' ? 'restartBridge' : 'restart' });
    return;
  }
  if (action === 'diagnose') { await check(); return; }
  if (busy) return;
  busy = true; state();
  let completed = false;
  try {
    if (['start', 'restart', 'restartBridge'].includes(action)) {
      const diagnostics = await check();
      if (!diagnostics.ok) { supervisor.attention('bridge',{code:'DIAGNOSTICS_FAILED',recoverable:false,message:'启动检查未通过，请先修复诊断项目。'});emit({ type: 'error', text: '启动检查未通过，请打开“启动诊断”修复红色项目。' }); return {ok:false}; }
      if (action === 'restart') await stop();
      if (action === 'restartBridge') await stopOne('bridge');
      if (!children.has('napcat')) {
        const env = await environment(dataRoot);
        externalNapcat = env.BOT_ONEBOT_MODE === 'external' || env.BOT_ONEBOT_MODE !== 'managed' && await onebotOnline(dataRoot);
        if (externalNapcat) emit({ type: 'log', text: env.BOT_ONEBOT_MODE === 'external' ? '[desktop] 连接指定的外部 OneBot；服务离线时等待重连，不启动或结束外部 NapCat。' : '[desktop] 复用已运行的 OneBot，不结束外部 NapCat 进程。' });
        else await launch('napcat', 'scripts/napcat-node.mjs');
      }
      if (!children.has('bridge')) await launch('bridge', 'dist/bridge.js');
    } else if (action === 'stop' || action === 'quit') { await stop(); if (action === 'quit') quitting = true; }
    completed = true;
  } finally { busy = false; emit({ type: 'control', action, ok: completed }); state(); }
  return {ok:completed};
}

const pendingComponents = new Set();
let queue=Promise.resolve(),closing=false,closeTask;
const cancelComponents=()=>{componentCancelEpoch++;for(const pending of pendingComponents)pending.cancelled=true;componentWorker?.send({action:'cancel'},()=>{});};
function receive(request) {
  const refused=text=>{emit({type:'error',text});return Promise.reject(new Error(text));};
  if(!request||typeof request!=='object'||Array.isArray(request)||!runtimeActions.has(request.action))return refused('未知运行管理操作');
  if(closing)return refused('运行管理服务正在关闭');
  if(request.action==='maintenance-cancel'){maintenanceCancelRequested=true;maintenanceWorker?.send({action:'cancel'},()=>{});return Promise.resolve();}
  if(maintenanceQueued&&!['stop','quit','maintenance-cancel'].includes(request.action))return refused('请等待数据维护完成或取消后再操作。');
  if(request.action==='maintenance'&&request.data?.operation!=='status'){maintenanceQueued=true;maintenanceCancelRequested=false;}
  if(['stop','quit','restart','restartBridge'].includes(request.action))for(const name of request.action==='restartBridge'?['bridge']:['bridge','napcat']){desired.delete(name);supervisor.stopped(name);}
  if(request.action==='components')pendingComponents.add(request);
  if(request.action==='components-cancel'||request.action==='quit')cancelComponents();
  if(['stop','quit'].includes(request.action)&&maintenanceQueued){maintenanceCancelRequested=true;maintenanceWorker?.send({action:'cancel'},()=>{});}
  if(request.action==='components-cancel')return Promise.resolve();
  const task=queue.then(async()=>{
    try {if(request.action==='components'&&request.cancelled)throw new Error('组件准备已取消');return await command(request);}
    catch(error){if(error.runtimeComponent&&desired.has(error.runtimeComponent)&&!closing)supervisor.exited(error.runtimeComponent,classifyRuntimeFailure(error));emit({type:'error',action:request.action,text:error.message});throw error;}
    finally{pendingComponents.delete(request);if(request.action==='maintenance'&&request.data?.operation!=='status')maintenanceQueued=false;}
  });
  queue=task.catch(()=>{});return task;
}
function close() {
  if(closeTask)return closeTask;
  closing=true;cancelComponents();maintenanceCancelRequested=true;maintenanceWorker?.send({action:'cancel'},()=>{});desired.clear();supervisor.close();for(const worker of configWorkers)void processGuard.terminate(worker);
  closeTask=(async()=>{await queue;try{await stop();}finally{await processGuard.close();await lease.release();}})();
  return closeTask;
}
lease.lost.then(async error=>{if(!error)return;emit({type:'error',text:error.message});try{await close();}finally{onFatal(error);}}).catch(()=>{});
processGuard.onLost=error=>{emit({type:'error',text:error.message});void close().finally(()=>onFatal(error));};
try{for(const text of readFileSync(logPath,'utf8').trim().split('\n').slice(-100))if(text)onEvent({type:'log',text:redact(text),historical:true});}catch{}
state();
return {receive,close,readConfiguration:()=>configuration.read(),updateConfiguration(data){
  if(closing)return Promise.reject(new Error('运行管理服务正在关闭'));
  if(maintenanceQueued)return Promise.reject(new Error('请等待数据维护完成后再保存配置。'));
  const task=queue.then(async()=>{if(!lease.held)throw new Error('运行管理实例锁已失效');const result=await configuration.update(data);await refreshSecrets();return result;});
  queue=task.catch(()=>{});return task;
},get quitting(){return quitting;}};
} catch(error){await processGuard?.close();await lease.release();throw error;}
}
