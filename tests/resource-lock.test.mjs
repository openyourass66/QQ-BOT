import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataResources, ResourceLockedError } from '../dist/core/resource-lock.js';
import { dataPaths, mutableDataResources } from '../dist/core/data-paths.js';
import { withTimeout } from '../dist/core/runtime.js';

const resource = path => ({ path, label: '测试数据' });
function holder(resources) {
  const child = fork(fileURLToPath(new URL('./fixtures/resource-lock-holder.mjs', import.meta.url)), [], { silent: true, execArgv: [], windowsHide: true });
  const exited = once(child, 'exit');
  const ready = withTimeout(new Promise((done, reject) => {
    child.once('message', done);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('锁进程在报告状态前退出')));
  }), 5000);
  child.send({ resources });
  return { child, ready, exited };
}
async function finish(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
  await process.exited;
}

test('资源路径统一解析，独立覆盖的额度和存档仍纳入保护', () => {
  const root = resolve('test-instance');
  const paths = dataPaths({ SESSION_STORE: 'custom/sessions.json', BOT_USAGE_STORE: 'shared/usage.json', BOT_SOCIAL_STORE: 'shared/social.json' }, root);
  assert.equal(paths.groupContext, join(root, 'custom/group-context.json'));
  assert.equal(paths.media, join(root, 'custom/media'));
  assert.equal(paths.usage, join(root, 'shared/usage.json'));
  assert.equal(mutableDataResources(paths).length, 7);
});

test('资源锁去重、处理目录联接与路径大小写，释放可重复调用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-lock-alias-'));
  let lease;
  try {
    const actual = join(root, 'actual'); await mkdir(actual);
    const alias = join(root, 'alias'); await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(actual, 'nested/state.json');
    lease = await acquireDataResources([resource(path), resource(join(alias, 'nested/state.json'))]);
    await assert.rejects(acquireDataResources([resource(join(alias, 'nested/state.json'))]), ResourceLockedError);
    if (process.platform === 'win32') await assert.rejects(acquireDataResources([resource(path.toUpperCase())]), ResourceLockedError);
    lease.release(); lease.release();
    const next = await acquireDataResources([resource(path)]); next.release();
  } finally { lease?.release(); await rm(root, { recursive: true, force: true }); }
});

test('多个资源有一个冲突时释放本次已获取的锁，不修改数据原文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-lock-rollback-'));
  let owner;
  try {
    const a = join(root, 'a.json'), z = join(root, 'z.json');
    await writeFile(z, 'original');
    owner = await acquireDataResources([resource(z)]);
    await assert.rejects(acquireDataResources([resource(a), resource(z)]), ResourceLockedError);
    const next = await acquireDataResources([resource(a)]); next.release();
    assert.equal(await readFile(z, 'utf8'), 'original');
  } finally { owner?.release(); await rm(root, { recursive: true, force: true }); }
});

test('两个真实进程同时争用相同资源只有一个成功，进程崩溃后系统释放锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-lock-process-'));
  const a = holder([resource(join(root, 'data.json'))]);
  const b = holder([resource(join(root, 'data.json'))]);
  try {
    const results = await Promise.all([a.ready, b.ready]);
    assert.equal(results.filter(r => r.type === 'locked').length, 1, JSON.stringify(results));
    assert.equal(results.find(r => r.type === 'failed').code, 'BOT_RESOURCE_LOCKED');
    const winner = results[0].type === 'locked' ? a : b;
    await finish(winner);
    const next = await acquireDataResources([resource(join(root, 'data.json'))]); next.release();
  } finally { await Promise.all([finish(a), finish(b)]); await rm(root, { recursive: true, force: true }); }
});

test('取消或不支持的硬链接数据文件不会留下已获取的锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-lock-invalid-'));
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(acquireDataResources([resource(join(root, 'a'))], controller.signal), { name: 'AbortError' });
    const file = join(root, 'state.json'); await writeFile(file, 'original'); await link(file, join(root, 'linked.json'));
    await assert.rejects(acquireDataResources([resource(join(root, 'a')), resource(file)]), /硬链接/);
    if (process.platform !== 'win32') {
      const symbolic = join(root, 'symbolic.json'); await symlink(file, symbolic);
      await assert.rejects(acquireDataResources([resource(symbolic)]), /符号链接/);
    }
    const next = await acquireDataResources([resource(join(root, 'a'))]); next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('独立命令行占用数据时，桥接及离线桌面管理均在加载/改写数据之前拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-lock-entry-'));
  const env = { ...process.env, SESSION_STORE: join(root, 'sessions.json'), BOT_USAGE_STORE: '', BOT_SOCIAL_STORE: '', BOT_GROUP_CONTEXT_STORE: '', BOT_MEDIA_DIR: '', BOT_SETTINGS_FILE: join(root, 'settings.json'), BOT_WORKSPACE: root, BOT_CHAT_MODE: 'profile', BOT_DSH_BIN: join(root, 'must-not-start') };
  const paths = dataPaths(env, root);
  const owner = holder(mutableDataResources(paths));
  let bridge, worker;
  try {
    assert.equal((await owner.ready).type, 'locked');
    await writeFile(paths.social, 'preserve malformed data');
    bridge = spawn(process.execPath, [resolve('dist/bridge.js')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; bridge.stdout.on('data', data => { output += data; }); bridge.stderr.on('data', data => { output += data; });
    assert.equal((await withTimeout(once(bridge, 'exit'), 5000))[0], 1);
    assert.match(output, /数据资源正在使用/);
    assert.doesNotMatch(output, /must-not-start/);
    worker = fork(resolve('desktop/config-worker.mjs'), [], { cwd: root, env, silent: true, execArgv: [], windowsHide: true });
    const exited = once(worker, 'exit'); const response = once(worker, 'message');
    worker.send({ action: 'social', data: { op: 'list', section: 'contacts' } });
    const [result] = await withTimeout(response, 5000); await exited;
    assert.equal(result.ok, false); assert.match(result.error, /数据资源正在使用/);
    assert.equal(await readFile(paths.social, 'utf8'), 'preserve malformed data');
    await assert.rejects(stat(env.BOT_SETTINGS_FILE), { code: 'ENOENT' });
  } finally {
    if (bridge?.exitCode === null) { const exited = once(bridge, 'exit'); bridge.kill('SIGKILL'); await exited; }
    if (worker?.exitCode === null) { const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited; }
    await finish(owner); await rm(root, { recursive: true, force: true });
  }
});
