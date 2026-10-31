import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeLayout } from './app-paths.mjs';

/**
 * 桌面控制台的远程连接转发进程。
 * stdin/stdout 保持与 desktop/host.mjs 相同的单行 JSON 协议，
 * 只把请求转给服务器上的 whaled 管理接口；断开本连接不会停止机器人。
 */

const MAX_LINE = 4 * 1024 * 1024;
const MAX_PENDING = 64;
const CONNECT_ATTEMPTS = 50;
const CONNECT_DELAY = 100;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let socket, input, connected = false, finished = false, quitRequested = false, stdinClosed = false, attempts = 0, fatal;
const pending = [];
let reported = false;

function emit(event) { process.stdout.write(JSON.stringify(event) + '\n'); }

function reportVoid() {
  if (reported) return;
  reported = true;
  emit({ type: 'error', text: `无法连接服务器守护进程（${socketPath}）：${fatal?.message || '请确认 whaled.service 正在运行'}。` });
}

function finish(code) {
  if (finished) return;
  finished = true;
  try { input?.close(); } catch { /* 输入已经结束 */ }
  try { socket?.end(); } catch { /* 连接可能已断开 */ }
  let exited = false;
  const exit = () => { if (exited) return; exited = true; setTimeout(() => process.exit(code), 50); };
  if (!socket || socket.destroyed || !connected) return exit();
  socket.once('close', exit);
  setTimeout(exit, 500);
}

let layout;
try { layout = await runtimeLayout({ root, args: process.argv.slice(2) }); }
catch (error) { emit({ type: 'error', text: `远程控制连接不可用：${error.message}` }); process.exit(1); }

const socketPath = join(layout.dataRoot, 'run', 'whaled.sock');

function open() {
  if (finished) return;
  const sock = connect(socketPath);
  socket = sock;
  sock.once('connect', () => {
    connected = true;
    for (const line of pending.splice(0)) sock.write(line + '\n');
  });
  sock.on('data', chunk => { if (!process.stdout.write(chunk)) sock.pause(); });
  sock.on('error', error => { if (!connected && !['ENOENT', 'ECONNREFUSED'].includes(error.code)) fatal = error; });
  sock.once('close', () => {
    if (sock !== socket) return;
    if (!connected) {
      if (!finished && !fatal && attempts++ < CONNECT_ATTEMPTS) { setTimeout(open, CONNECT_DELAY); return; }
      reportVoid();
      finish(1);
      return;
    }
    if (finished) return;
    if (!quitRequested && !stdinClosed) emit({ type: 'error', text: '与服务器守护进程的连接已断开；请确认服务器服务状态后重新连接。' });
    finish(quitRequested || stdinClosed ? 0 : 1);
  });
}

process.stdout.on('drain', () => { if (socket && socket.isPaused()) socket.resume(); });
process.stdout.on('error', () => { try { socket?.destroy(); } catch { /* 已断开 */ } process.exit(0); });

open();

input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('error', () => finish(0));
input.on('line', line => {
  let request;
  try {
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error('too large');
    request = JSON.parse(line);
  } catch { emit({ type: 'error', text: '控制命令格式无效或过大' }); return; }
  if (request?.action === 'quit') quitRequested = true;
  if (connected) {
    if (!socket.write(line + '\n')) { input.pause(); socket.once('drain', () => input.resume()); }
  } else if (pending.length < MAX_PENDING) pending.push(line);
  else emit({ type: 'error', text: '等待连接服务器超时，请重新打开控制台。' });
});
input.once('close', () => { stdinClosed = true; finish(0); });
process.once('SIGTERM', () => finish(0));
process.once('SIGINT', () => finish(0));
