import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAdmin } from './admin.js';
import { getSettings, loadSettings, saveSettings, watchSettings } from './settings.js';
import { log, snapshotStatus, subprocessLogLevel } from './state.js';
import { config } from './config.js';
import { SessionStore } from './store.js';
import { createConnection } from 'node:net';

let child: ChildProcess | undefined;
let napcat: ChildProcess | undefined;
let childUrl = '';
let phase = 'stopped';
let busy = false;
let closing = false;
let lastError = '';
const childToken = randomBytes(24).toString('hex');
const personaPath = resolve(config.dsh.workspace, 'AGENTS.md');

async function bridgeApi(path: string, method = 'GET'): Promise<any> {
  if (!childUrl || phase !== 'running') throw new Error('机器人尚未就绪，请先启动并等待连接完成');
  const response = await fetch(`${childUrl}${path}`, {
    method, headers: { 'x-admin-token': childToken }, signal: AbortSignal.timeout(5000),
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body.error ?? '桥接请求失败');
  return body;
}

async function startNapcat(): Promise<void> {
  const entry = process.env.BOT_NAPCAT_ENTRY;
  if (!entry || napcat) return;
  const endpoint = new URL(config.onebot.httpUrl);
  if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
    throw new Error('自动启动 NapCat 仅支持本机 OneBot 地址');
  }
  const listening = await new Promise<boolean>((done) => {
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)) });
    const finish = (connected: boolean): void => { socket.destroy(); done(connected); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
  if (listening || closing) return;
  const path = resolve(entry);
  await access(path);
  if (closing) return;
  const proc = spawn(process.execPath, [path], {
    env: process.env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  napcat = proc;
  for (const stream of [proc.stdout, proc.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (data: string) => {
      pending += data;
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
      for (const line of lines) if (line) log(subprocessLogLevel(line), `[napcat] ${line}`);
    });
  }
  proc.on('error', (error) => { log('error', `[napcat] ${error.message}`); if (napcat === proc) napcat = undefined; });
  proc.on('exit', (code) => {
    if (napcat === proc) napcat = undefined;
    log(code ? 'error' : 'info', `[napcat] 运行进程退出（${code}）`);
  });
  log('info', '[napcat] 正在启动本地 Node 运行环境');
}

async function stopNapcat(): Promise<void> {
  const proc = napcat;
  if (!proc) return;
  await new Promise<void>((done) => {
    proc.once('exit', () => done());
    proc.kill('SIGTERM');
  });
}

async function start(): Promise<void> {
  if (child) return;
  try { await startNapcat(); }
  catch (error) { phase = 'failed'; lastError = `NapCat 启动失败：${String(error)}`; throw error; }
  if (closing) return;
  phase = 'starting';
  lastError = '';
  childUrl = '';
  const proc = fork(fileURLToPath(new URL('./bridge.js', import.meta.url)), [], {
    env: { ...process.env, ADMIN_UI_PORT: '0', ADMIN_UI_TOKEN: childToken },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child = proc;
  for (const stream of [proc.stdout, proc.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (data: string) => {
      pending += data;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        log(subprocessLogLevel(line), line);
        const match = line.match(/^\[admin\] (http:\/\/127\.0\.0\.1:\d+)$/);
        if (match && phase === 'starting') { childUrl = match[1]; phase = 'running'; }
      }
    });
  }
  proc.on('error', (error) => { lastError = error.message; log('error', lastError); });
  proc.on('exit', (code) => {
    if (phase !== 'stopping' && code !== 0) lastError = `机器人退出（${code ?? '信号终止'}），请查看运行日志`;
    child = undefined; childUrl = ''; phase = lastError ? 'failed' : 'stopped';
    log('info', `机器人已退出，退出码 ${code}`);
  });
  log('info', '正在启动机器人…');
}

async function stop(): Promise<void> {
  const proc = child;
  if (!proc) return;
  phase = 'stopping';
  lastError = '';
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
        killer.on('error', (error) => log('error', String(error)));
      } else proc.kill('SIGKILL');
    }, 8000);
    proc.once('exit', () => { clearTimeout(timer); done(); });
    if (proc.connected) proc.send('shutdown', (error) => { if (error) log('warn', error.message); });
    else proc.kill('SIGTERM');
  });
}

await loadSettings();
const unwatch = watchSettings();
const server = await startAdmin({
  getSettings,
  saveSettings,
  getStatus: async () => {
    const base = { ...snapshotStatus(), uptimeMs: 0, phase, lastError, pid: child?.pid ?? null };
    if (phase !== 'running') return base;
    try { return { ...await bridgeApi('/api/status'), phase, pid: child?.pid }; }
    catch (error) { return { ...base, lastError: String(error), phase: 'unreachable' }; }
  },
  control: async (action) => {
    if (closing) throw new Error('控制服务正在退出');
    if (busy) throw new Error('正在执行其他控制操作，请稍后再试');
    busy = true;
    try {
      if (action === 'stop' || action === 'restart') { await stop(); await stopNapcat(); }
      if (!closing && (action === 'start' || action === 'restart')) await start();
      return { phase };
    } finally { busy = false; }
  },
  getPersona: async () => {
    try { return await readFile(personaPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  },
  savePersona: async (content) => { await mkdir(dirname(personaPath), { recursive: true }); await writeFile(personaPath, content, 'utf8'); },
  getSessions: async () => {
    if (child) return (await bridgeApi('/api/sessions')).sessions;
    const store = new SessionStore(process.env.SESSION_STORE);
    await store.load(); return store.list();
  },
  deleteSession: async (key) => {
    if (child) { await bridgeApi(`/api/sessions?key=${encodeURIComponent(key)}`, 'DELETE'); return; }
    // 禁止离线删除，避免与启动中的桥接同时写会话文件。
    throw new Error('请启动机器人后重置会话');
  },
  testSend: async (text) => {
    const target = getSettings().approval.adminQq;
    if (!target) throw new Error('请先配置管理员 QQ');
    if (!childUrl) throw new Error('请先启动机器人');
    const response = await fetch(`${childUrl}/api/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': childToken },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(16000),
    });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(body.error ?? '发送失败');
    return body;
  },
  getLoginInfo: () => bridgeApi('/api/login-info'),
});
log('info', '桌面控制服务已就绪，等待启动机器人');
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await stop(); await stopNapcat(); unwatch(); await server.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
if (process.env.BOT_DESKTOP === '1') {
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    if (input.includes('shutdown\n') || input.includes('shutdown\r\n')) void shutdown();
    if (input.length > 1000) input = input.slice(-1000);
  });
  process.stdin.on('end', () => { void shutdown(); });
}
