import { fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { mkdirSync, appendFileSync, existsSync, statSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { diagnose, environment, onebotOnline } from './diagnostics.mjs';
import { enterRuntime, prepareRuntime } from '../scripts/app-paths.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layout = await prepareRuntime({ root, args: process.argv.slice(2) });
enterRuntime(layout, { loadEnv: false });
const dataRoot = layout.dataRoot;
const logDir = layout.logDir; mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, 'console.log');
const children = new Map();
const socialRequests = new Map();
let socialSequence = 0;
let busy = false, quitting = false, externalNapcat = false;
let componentWorker;
async function components(operation, data) {
  if (componentWorker) throw new Error('组件准备正在进行，请等待完成或取消');
  if (operation === 'install' && (children.has('bridge') || children.has('napcat'))) throw new Error('请先停止机器人，再准备或修复组件');
  return new Promise((done,reject)=>{
    const worker = fork(resolve(root,'desktop/component-worker.mjs'),[],{cwd:dataRoot,silent:true,execArgv:[],windowsHide:true});
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
async function refreshSecrets() { const env = await environment(dataRoot); secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && value?.length >= 4).map(([, value]) => value); }
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
  process.stdout.write(JSON.stringify(event) + '\n');
};
const state = () => emit({ type: 'state', bridge: children.has('bridge'), napcat: children.has('napcat') || externalNapcat, externalNapcat, busy, paths: layout });
async function launch(name, script) {
  const env = await environment(dataRoot);
  env.BOT_DATA_DIR = dataRoot;
  let execPath = process.execPath;
  if (name === 'napcat') {
    const { installedComponent } = await import('../scripts/component-paths.mjs');
    const managed = await installedComponent('napcat',dataRoot,root);
    if (managed && resolve(dataRoot,env.BOT_NAPCAT_DIR || 'napcat/shell') === join(managed.directory,'napcat')) execPath = join(managed.directory,'node.exe');
  }
  const child = fork(resolve(root, script), [], { cwd: dataRoot, env, execPath, execArgv: [], silent: true, windowsHide: true });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', text => {
      text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 8000);
      emit({ type: 'log', source: name, text: `[${name}] ${text}` });
      if (/EPERM.*cordis\.yml/.test(text)) emit({ type: 'error', text: 'DSH 无法写入 Profile 的 cordis.yml。请关闭占用该文件的程序、检查文件访问权限，再点击“重连模型”。NapCat 会继续保持登录。' });
    });
  }
  child.on('message', message => {
    if (name !== 'bridge') return;
    if (message?.type === 'status') emit(message);
    if (message?.type === 'social-result') { const pending = socialRequests.get(message.id); if (pending) { socialRequests.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.done(message.result); } }
  });
  child.on('error', error => emit({ type: 'error', text: `${name} 启动失败：${error.code || error.message}` }));
  child.on('exit', (code, signal) => { if (children.get(name) === child) children.delete(name); emit({ type: code ? 'error' : 'log', text: `[${name}] 已退出，代码 ${code ?? signal}` }); state(); });
}
async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') await new Promise(done => { const p = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); p.on('error', done); p.on('exit', done); });
  else child.kill('SIGKILL');
}
async function stopOne(name) {
  const child = children.get(name); if (!child) return;
  if (name === 'bridge' && child.connected) child.send('shutdown', () => {});
  else await killTree(child);
  await new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const timer = setTimeout(done, 7000); child.once('exit', () => { clearTimeout(timer); done(); });
  });
  await killTree(child);
}
async function stop() { await stopOne('bridge'); await stopOne('napcat'); externalNapcat = false; }
async function config(action, data) {
  return new Promise((done, reject) => {
    const worker = fork(resolve(root, 'desktop/config-worker.mjs'), [], { cwd: dataRoot, silent: true, execArgv: [], windowsHide: true });
    const timeout = setTimeout(() => { worker.kill(); reject(new Error('配置操作超时，请重试')); }, action === 'qzone-check' ? 30000 : action === 'model' ? 25000 : 10000);
    let replied = false;
    worker.once('message', result => { replied = true; clearTimeout(timeout); result.ok ? done(result.result) : reject(new Error(result.error)); });
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
      if (!diagnostics.ok) { emit({ type: 'error', text: '启动检查未通过，请打开“启动诊断”修复红色项目。' }); return; }
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
  } finally { busy = false; emit({ type: 'control', action, ok: completed }); state(); if (quitting) process.exit(); }
}
const input = createInterface({ input: process.stdin });
let queue = Promise.resolve();
const pendingComponents = new Set();
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { emit({type:'error',text:'控制命令格式无效'}); return; }
  if (request.action === 'components') pendingComponents.add(request);
  if (request.action === 'components-cancel' || request.action === 'quit') { for(const pending of pendingComponents)pending.cancelled=true; componentWorker?.send({action:'cancel'},()=>{}); }
  if (request.action === 'components-cancel') return;
  queue = queue.then(async () => { try { if(request.action==='components'&&request.cancelled)throw new Error('组件准备已取消'); await command(request); } catch (error) { emit({ type: 'error', action: request?.action, text: error.message }); } finally { pendingComponents.delete(request); } });
});
input.on('close', () => { for(const pending of pendingComponents)pending.cancelled=true; componentWorker?.send({action:'cancel'},()=>{}); queue.finally(async () => { await stop(); process.exit(); }); });
try { for (const text of readFileSync(logPath, 'utf8').trim().split('\n').slice(-100)) if (text) process.stdout.write(JSON.stringify({ type: 'log', text: redact(text), historical: true }) + '\n'); } catch {}
state();
