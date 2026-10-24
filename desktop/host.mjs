import { fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { mkdirSync, appendFileSync, existsSync, statSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { diagnose, environment, onebotOnline } from './diagnostics.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const logDir = join(root, 'data/desktop'); mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, 'console.log');
const children = new Map();
let busy = false, quitting = false, externalNapcat = false;
let secrets = [];
async function refreshSecrets() { const env = await environment(root); secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && value?.length >= 4).map(([, value]) => value); }
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
const state = () => emit({ type: 'state', bridge: children.has('bridge'), napcat: children.has('napcat') || externalNapcat, externalNapcat, busy });
function launch(name, script) {
  const child = fork(resolve(root, script), [], { cwd: root, execArgv: ['--env-file-if-exists=.env'], silent: true, windowsHide: true });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', text => {
      text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 8000);
      emit({ type: 'log', source: name, text: `[${name}] ${text}` });
      if (/EPERM.*cordis\.yml/.test(text)) emit({ type: 'error', text: 'DSH 无法写入 Profile 的 cordis.yml。请关闭占用该文件的程序、检查文件访问权限，再点击“重连模型”。NapCat 会继续保持登录。' });
    });
  }
  child.on('message', message => { if (name === 'bridge' && message?.type === 'status') emit(message); });
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
    const worker = fork(resolve(root, 'desktop/config-worker.mjs'), [], { cwd: root, silent: true, execArgv: [], windowsHide: true });
    const timeout = setTimeout(() => { worker.kill(); reject(new Error('配置操作超时')); }, 10000);
    let replied = false;
    worker.once('message', result => { replied = true; clearTimeout(timeout); result.ok ? done(result.result) : reject(new Error(result.error)); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', () => { clearTimeout(timeout); if (!replied) reject(new Error('配置读取失败，请检查构建文件与配置格式')); });
    worker.send({ action, data });
  });
}
async function check() { const result = await diagnose(root); emit({ type: 'diagnostics', ...result }); return result; }
async function command({ action, data }) {
  if (action === 'load' || ['settings', 'env', 'runtime', 'persona'].includes(action)) {
    const result = await config(action, data);
    emit(action === 'load' ? { type: 'config', ...result } : { type: 'saved', section: action, result });
    await refreshSecrets(); return;
  }
  if (action === 'diagnose') { await check(); return; }
  if (busy) return;
  busy = true; state();
  try {
    if (['start', 'restart', 'restartBridge'].includes(action)) {
      const diagnostics = await check();
      if (!diagnostics.ok) { emit({ type: 'error', text: '启动检查未通过，请打开“启动诊断”修复红色项目。' }); return; }
      if (action === 'restart') await stop();
      if (action === 'restartBridge') await stopOne('bridge');
      if (!children.has('napcat')) {
        externalNapcat = await onebotOnline(root);
        if (externalNapcat) emit({ type: 'log', text: '[desktop] 复用已运行的 OneBot，不结束外部 NapCat 进程。' });
        else launch('napcat', 'scripts/napcat-node.mjs');
      }
      if (!children.has('bridge')) launch('bridge', 'dist/bridge.js');
    } else if (action === 'stop' || action === 'quit') { await stop(); if (action === 'quit') quitting = true; }
  } finally { busy = false; state(); if (quitting) process.exit(); }
}
const input = createInterface({ input: process.stdin });
let queue = Promise.resolve();
input.on('line', line => { queue = queue.then(async () => { try { await command(JSON.parse(line)); } catch (error) { emit({ type: 'error', text: error.message }); } }); });
input.on('close', () => { queue.finally(async () => { await stop(); process.exit(); }); });
try { for (const text of readFileSync(logPath, 'utf8').trim().split('\n').slice(-100)) if (text) process.stdout.write(JSON.stringify({ type: 'log', text: redact(text), historical: true }) + '\n'); } catch {}
state();
