import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('未运行 OneBot 时启动受管 NapCat，停止与关闭控制台清理自有进程', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-companion-'));
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((done) => reserve.close(done));
  const pidFile = join(dir, 'napcat.pid');
  const entry = join(dir, 'fake-napcat.mjs');
  await writeFile(entry, `import {createServer} from 'node:http';import{writeFileSync}from'node:fs';
const server=createServer((req,res)=>{req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:10000,nickname:'companion'}}));});
server.listen(${port},'127.0.0.1',()=>writeFileSync(${JSON.stringify(pidFile)},String(process.pid)));`);
  const wrapper = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake-dsh');
  const fixture = resolve('tests/fixtures/fake-dsh.mjs');
  await writeFile(wrapper, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`, { mode: 0o700 });
  let output = '', resolveReady, companionPid;
  const ready = new Promise((done) => { resolveReady = done; });
  const proc = spawn(process.execPath, [resolve('dist/console.js')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, BOT_DESKTOP: '1', ADMIN_UI_PORT: '0', ADMIN_UI_TOKEN: 'test', BOT_NAPCAT_ENTRY: entry,
    BOT_SETTINGS_FILE: join(dir, 'settings.json'), BOT_WORKSPACE: dir, SESSION_STORE: join(dir, 'sessions.json'), BOT_USAGE_STORE: join(dir, 'usage.json'),
    BOT_DSH_BIN: wrapper, ONEBOT_HTTP_URL: `http://127.0.0.1:${port}`, ONEBOT_WS_URL: 'ws://127.0.0.1:1', ONEBOT_TOKEN: '',
  } });
  proc.stdout.on('data', (data) => { output += data; const match = output.match(/\[admin\] (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveReady(match[1]); });
  proc.stderr.on('data', (data) => { output += data; });
  const until = async (check) => {
    for (let i = 0; i < 120; i++) { const result = await check(); if (result) return result; await new Promise((done) => setTimeout(done, 50)); }
    throw new Error(`等待受管进程超时\n${output}`);
  };
  try {
    const url = await ready;
    const api = async (path, body) => {
      const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-admin-token': 'test', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('control', { action: 'start' });
    companionPid = await until(() => readFile(pidFile, 'utf8').then(Number).catch(() => false));
    await until(async () => (await api('status')).phase === 'running');
    await api('control', { action: 'stop' });
    assert.throws(() => process.kill(companionPid, 0), /ESRCH/);
    assert.equal((await api('status')).phase, 'stopped');
    await api('control', { action: 'start' });
    companionPid = await until(async () => { const pid = Number(await readFile(pidFile, 'utf8')); return pid !== companionPid && pid; });
    await until(async () => (await api('status')).phase === 'running');
    const exited = once(proc, 'exit'); proc.stdin.end(); await exited;
    assert.equal(proc.exitCode, 0, output);
    assert.throws(() => process.kill(companionPid, 0), /ESRCH/);
  } finally {
    if (proc.exitCode === null) { const exited = once(proc, 'exit'); proc.stdin.end(); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
