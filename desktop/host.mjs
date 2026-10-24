import { fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const children = new Map();
let busy = false, quitting = false;
const state = () => emit({ type: 'state', bridge: children.has('bridge'), napcat: children.has('napcat'), busy });
function launch(name, script) {
  const child = fork(resolve(root, script), [], { cwd: root, execArgv: ['--env-file-if-exists=.env'], silent: true, windowsHide: true });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    const lines = createInterface({ input: stream });
    lines.on('line', text => emit({ type: 'log', text: `[${name}] ${text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 8000)}` }));
  }
  child.on('message', message => { if (name === 'bridge' && message?.type === 'status') emit(message); });
  child.on('error', () => emit({ type: 'error', text: `${name} 启动失败，请检查 Node 和运行文件。` }));
  child.on('exit', (code) => { children.delete(name); emit({ type: 'log', text: `[${name}] 已退出，代码 ${code}` }); state(); });
}
async function killTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') await new Promise(done => { const p = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); p.on('error', done); p.on('exit', done); });
  else child.kill('SIGKILL');
}
async function stopOne(name) {
  const child = children.get(name); if (!child) return;
  if (name === 'bridge' && child.connected) child.send('shutdown', () => {});
  else { await killTree(child); }
  await Promise.race([new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); }), new Promise(done => setTimeout(done, 7000))]);
  await killTree(child);
}
async function stop() { await stopOne('bridge'); await stopOne('napcat'); }
async function config(action, data) {
  return new Promise((done, reject) => {
    const worker = fork(resolve(root, 'desktop/config-worker.mjs'), [], { cwd: root, silent: true, execArgv: [], windowsHide: true });
    const timeout = setTimeout(() => { worker.kill(); reject(new Error('配置操作超时')); }, 10000);
    let replied = false;
    worker.once('message', result => { replied = true; clearTimeout(timeout); result.ok ? done(result.result) : reject(new Error(result.error)); });
    worker.once('error', reject);
    worker.once('exit', () => { clearTimeout(timeout); if (!replied) reject(new Error('配置读取失败，请先构建项目并检查配置文件')); });
    worker.send({ action, data });
  });
}
async function command(message) {
  const { action, data } = message;
  if (action === 'load' || ['settings', 'env', 'persona'].includes(action)) {
    try { const result = await config(action, data); emit(action === 'load' ? { type: 'config', ...result } : { type: 'saved', section: action }); }
    catch (e) { emit({ type: 'error', text: e.message }); }
    return;
  }
  if (busy) return;
  busy = true; state();
  try {
    if (action === 'start' || action === 'restart') {
      if (action === 'restart') await stop();
      if (!children.has('napcat')) launch('napcat', 'scripts/napcat-node.mjs');
      if (!children.has('bridge')) launch('bridge', 'dist/bridge.js');
    } else if (action === 'stop' || action === 'quit') { await stop(); if (action === 'quit') quitting = true; }
  } finally { busy = false; state(); if (quitting) process.exit(); }
}
const input = createInterface({ input: process.stdin });
let queue = Promise.resolve();
input.on('line', line => { queue = queue.then(async () => { try { await command(JSON.parse(line)); } catch { emit({ type: 'error', text: '操作失败，请检查运行环境。' }); } }); });
input.on('close', () => { queue.finally(async () => { await stop(); process.exit(); }); });
state();
