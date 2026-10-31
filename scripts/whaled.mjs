import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline';
import { access, chmod, mkdir, unlink } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntime, enterRuntime } from './app-paths.mjs';
import { createRuntimeService } from './runtime-service.mjs';

const MAX_LINE = 4 * 1024 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const HISTORY_LIMIT = 100;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') { console.error('[whaled] 守护进程仅用于 Linux/macOS；Windows 请直接启动桌面控制台。'); process.exit(1); }
const layout = await prepareRuntime({ root, args: process.argv.slice(2) });
enterRuntime(layout, { loadEnv: false });

const runDirectory = join(layout.dataRoot, 'run');
const socketPath = join(runDirectory, 'whaled.sock');
const autostartMarker = join(runDirectory, 'autostart');

const clients = new Set();
const history = [];
let latestState, server, service, closing, bound = false;

function writeEvent(socket, event) {
  if (socket.destroyed) return;
  const line = JSON.stringify(event) + '\n';
  if (socket.writableLength + Buffer.byteLength(line) > MAX_BUFFERED) { socket.destroy(); clients.delete(socket); return; }
  socket.write(line);
}

function broadcast(event) {
  if (event.type === 'state') latestState = event;
  if (event.type === 'log') { history.push(event); if (history.length > HISTORY_LIMIT) history.shift(); }
  for (const socket of clients) writeEvent(socket, event);
}

/** 只记录“用户希望机器人运行”，作为守护进程重启后的恢复依据；不记录任何凭据。 */
function trackAutostart(event) {
  if (event.type !== 'control' || event.ok !== true) return;
  try {
    if (event.action === 'start' || event.action === 'restart') writeFileSync(autostartMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    else if (event.action === 'stop' || event.action === 'quit') rmSync(autostartMarker, { force: true });
  } catch (error) { console.error(`[whaled] 无法记录自动启动状态：${error.message}`); }
}

function accept(socket) {
  clients.add(socket);
  for (const event of history) writeEvent(socket, event);
  if (latestState) writeEvent(socket, latestState);
  socket.on('error', () => {});
  let chain = Promise.resolve();
  const input = createInterface({ input: socket, crlfDelay: Infinity });
  input.on('error', () => { /* 客户端异常断开由 close 处理 */ });
  input.on('line', line => {
    let request;
    try {
      if (Buffer.byteLength(line) > MAX_LINE) throw new Error('too large');
      request = JSON.parse(line);
    } catch { writeEvent(socket, { type: 'error', text: '控制命令格式无效或过大' }); return; }
    chain = chain.then(async () => {
      try { await service.receive(request); } catch { /* 错误已经通过事件广播给所有客户端 */ }
      if (service.quitting) void shutdown(0);
    });
  });
  socket.once('close', () => clients.delete(socket));
}

function shutdown(code = 0) {
  if (closing) return closing;
  closing = (async () => {
    console.error('[whaled] 正在停止管理核心…');
    server?.close();
    if (bound) await unlink(socketPath).catch(() => {});
    try { await service?.close(); } catch (error) { console.error(`[whaled] 关闭管理核心失败：${error.message}`); }
    for (const socket of clients) { try { socket.end(); } catch { /* 客户端可能已断开 */ } }
    await new Promise(done => setTimeout(done, 150));
    for (const socket of clients) socket.destroy();
    process.exit(code);
  })();
  return closing;
}

/** 探测管理接口上是否已有守护进程；不创建任何文件。 */
function socketAlive(path) {
  return new Promise(done => {
    const probe = connect(path);
    let settled = false;
    const finish = alive => { if (settled) return; settled = true; clearTimeout(timer); probe.destroy(); done(alive); };
    const timer = setTimeout(() => finish(false), 1000);
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
  });
}

try {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
  if (await socketAlive(socketPath)) {
    console.error(`[whaled] 已有守护进程在运行：${socketPath}`);
    process.exit(0);
  }
  await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });

  const onEvent = event => { trackAutostart(event); broadcast(event); };
  service = await createRuntimeService({ root, layout, onEvent, onFatal: () => { void shutdown(1); } });

  server = createServer(accept);
  await new Promise((done, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(socketPath, () => { server.off('error', failed); done(); });
  });
  bound = true;
  await chmod(socketPath, 0o600);
  server.on('error', error => { console.error(`[whaled] 管理接口错误：${error.message}`); void shutdown(1); });
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
  console.error(`[whaled] 管理接口已就绪：${socketPath}`);

  if (await access(autostartMarker).then(() => true, () => false)) {
    console.error('[whaled] 上次退出时机器人仍在运行，正在按策略恢复…');
    void service.receive({ action: 'start' }).catch(() => {});
  }
} catch (error) {
  console.error(`[whaled] 启动失败：${error.message}`);
  try { await service?.close(); } catch { /* 启动阶段失败，已无可释放资源 */ }
  if (bound) await unlink(socketPath).catch(() => {});
  process.exit(1);
}
