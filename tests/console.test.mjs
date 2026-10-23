import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { subprocessLogLevel } from '../dist/state.js';

test('子进程正常 stderr 不误报错误，显式级别及真正失败仍保留', () => {
  assert.equal(subprocessLogLevel('[dsh] [mcp-qq] ready'), 'info');
  assert.equal(subprocessLogLevel('[dsh] model connection ready'), 'info');
  assert.equal(subprocessLogLevel('18:00 [info] previous error cleared'), 'info');
  assert.equal(subprocessLogLevel('[warn] connection retrying'), 'warn');
  assert.equal(subprocessLogLevel('[error] connection refused'), 'error');
  assert.equal(subprocessLogLevel('Error: fetch failed'), 'error');
});

test('桌面后台：鉴权、离线配置、启动、热更新、重复启动、重启、停止与窗口断开清理', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-console-'));
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10000, nickname: 'desktop-test' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  if (!ws.address()) await once(ws, 'listening');
  const wrapper = join(dir, process.platform === 'win32' ? 'fake dsh.cmd' : 'fake-dsh');
  const fixture = resolve('tests/fixtures/fake-dsh.mjs');
  await writeFile(wrapper, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`, { mode: 0o700 });
  const settingsPath = join(dir, 'settings.json');
  let output = '', child;
  let readyResolve;
  const ready = new Promise((done) => { readyResolve = done; });
  const waitFor = async (predicate, label) => {
    const end = Date.now() + 9000;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise((done) => setTimeout(done, 50)); }
    throw new Error(`等待 ${label} 超时\n${output}`);
  };
  try {
    child = spawn(process.execPath, [resolve('dist/console.js')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BOT_DESKTOP: '1', ADMIN_UI_PORT: '0', ADMIN_UI_TOKEN: 'desktop-test', BOT_SETTINGS_FILE: settingsPath,
        BOT_DSH_BIN: wrapper, BOT_DSH_PROFILE: 'acp', BOT_WORKSPACE: dir, SESSION_STORE: join(dir, 'sessions.json'), BOT_USAGE_STORE: join(dir, 'usage.json'),
        ONEBOT_HTTP_URL: `http://127.0.0.1:${server.address().port}`, ONEBOT_WS_URL: `ws://127.0.0.1:${ws.address().port}`, ONEBOT_TOKEN: '', BOT_SELF_ID: '10000', ADMIN_QQ: '0',
        // 已有外部 OneBot 时不应执行这个不存在的启动文件。
        BOT_NAPCAT_ENTRY: join(dir, 'must-not-start.mjs'),
      },
    });
    child.stdout.on('data', (chunk) => { output += chunk; const match = output.match(/\[admin\] (http:\/\/127\.0\.0\.1:\d+)/); if (match) readyResolve(match[1]); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const url = await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('控制服务启动超时')), 8000); timer.unref(); })]);
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(`${url}/api/${path}`, { method, headers: { 'x-admin-token': 'desktop-test', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/status`, { headers: { 'x-admin-token': 'desktop-test', origin: 'http://evil.test' } })).status, 403);
    assert.equal((await request('status')).phase, 'stopped');
    const settings = await request('settings'); settings.identity.name = '桌面测试';
    await request('settings', 'PUT', settings);
    assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).identity.name, '桌面测试');
    await request('persona', 'PUT', { content: '本地角色测试' });
    assert.equal((await request('persona')).content, '本地角色测试');
    assert.deepEqual((await request('sessions')).sessions, []);
    const invalid = await fetch(`${url}/api/control`, { method: 'POST', headers: { 'x-admin-token': 'desktop-test', 'content-type': 'application/json' }, body: '{"action":"invalid"}' });
    assert.equal(invalid.status, 400);
    await request('control', 'POST', { action: 'start' });
    const running = await waitFor(async () => { const status = await request('status'); return status.phase === 'running' && status.qqOnline && status; }, '启动');
    await request('control', 'POST', { action: 'start' });
    assert.equal((await request('status')).pid, running.pid);
    settings.identity.name = '热更新'; await request('settings', 'PUT', settings);
    await waitFor(async () => (await request('status')).settings.identity.name === '热更新', '配置热更新');
    await request('control', 'POST', { action: 'restart' });
    const restarted = await waitFor(async () => { const status = await request('status'); return status.phase === 'running' && status; }, '重启');
    assert.notEqual(restarted.pid, running.pid);
    await request('control', 'POST', { action: 'stop' });
    assert.equal((await request('status')).phase, 'stopped');
    assert.ok((await request('logs')).logs.length > 0);
    await request('control', 'POST', { action: 'start' });
    const final = await waitFor(async () => { const status = await request('status'); return status.phase === 'running' && status; }, '再次启动');
    const exited = once(child, 'exit'); child.stdin.end();
    await exited;
    assert.equal(child.exitCode, 0, output);
    assert.throws(() => process.kill(final.pid, 0), /ESRCH/);
  } finally {
    if (child && child.exitCode === null) { child.stdin.end(); await Promise.race([once(child, 'exit'), new Promise((done) => setTimeout(done, 10000))]); }
    for (const socket of ws.clients) socket.terminate();
    await new Promise((done) => ws.close(done));
    await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows 原生窗口与全部配置控件可加载', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'desktop/start.ps1', '-ValidateOnly'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (data) => { output += data; }); proc.stderr.on('data', (data) => { output += data; });
  await once(proc, 'exit');
  assert.equal(proc.exitCode, 0, output);
  assert.match(output, /36.*19/);
});

test('原生控件交互：异步状态、配置保存、人设、导航、会话、日志和关闭', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-native-'));
  try {
    const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'tests/desktop-smoke.ps1'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        BOT_SETTINGS_FILE: join(dir, 'settings.json'), BOT_WORKSPACE: dir, SESSION_STORE: join(dir, 'sessions.json'), BOT_USAGE_STORE: join(dir, 'usage.json'),
      },
    });
    let output = '';
    proc.stdout.on('data', (data) => { output += data; }); proc.stderr.on('data', (data) => { output += data; });
    await once(proc, 'exit');
    assert.equal(proc.exitCode, 0, output);
    assert.match(output, /Native UI smoke passed/);
    assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).identity.name, 'Native desktop test');
    assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), 'Native persona test');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
