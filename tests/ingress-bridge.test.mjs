import {readSocialData} from './helpers/social-data.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { withTimeout } from '../dist/core/runtime.js';

async function fixture(settings = {}, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qq-ingress-'));
  const sent = [], states = [];
  let sequence = 1, posts = 0, output = '', child;
  const http = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const args = JSON.parse(raw || '{}'); let data = {};
    if (req.url === '/get_login_info') data = { user_id: 10000, nickname: '测试' };
    if (req.url === '/send_private_msg' || req.url === '/send_group_msg') { sent.push(args); data = { message_id: sequence++ }; }
    if (req.url === '/send_qzone_msg') { posts++; data = { tid: 'mock-space-post' }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  if (!ws.address()) await once(ws, 'listening');
  const path = join(root, 'settings.json'), promptsPath = join(root, 'prompts.jsonl');
  const wrapper = join(root, process.platform === 'win32' ? 'fake.cmd' : 'fake-dsh');
  await writeFile(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${resolve('tests/fixtures/fake-dsh.mjs')}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${resolve('tests/fixtures/fake-dsh.mjs')}"\n`, { mode: 0o700 });
  await writeFile(path, JSON.stringify({ chat: { delay: { minMs: 0, maxMs: 0, chunkSize: 4000 } }, ...settings, social: { batchWindowMs: 1000, ...settings.social } }));
  const connection = once(ws, 'connection');
  child = spawn(process.execPath, [resolve('dist/bridge.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...process.env, BOT_CHAT_MODE: 'profile', BOT_DSH_BIN: wrapper, BOT_WORKSPACE: root,
    BOT_SETTINGS_FILE: path, SESSION_STORE: join(root, 'sessions.json'), BOT_SOCIAL_STORE: '', BOT_USAGE_STORE: '', BOT_GROUP_CONTEXT_STORE: '', BOT_MEDIA_DIR: '',
    ONEBOT_HTTP_URL: `http://127.0.0.1:${http.address().port}`, ONEBOT_WS_URL: `ws://127.0.0.1:${ws.address().port}`, ONEBOT_TOKEN: '',
    FAKE_GROUP_PROMPTS: promptsPath, TURN_TIMEOUT_MS: '10000', INGRESS_PER_CONVERSATION: '2', INGRESS_TOTAL: '3', INGRESS_MAX_BYTES: '16384', BATCH_MAX_BYTES: '4096', ...limits,
  } });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.on('message', message => { if (message.type === 'status') states.push(message); });
  const exited = once(child, 'exit');
  const until = async predicate => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      if (child.exitCode !== null) break;
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error('等待入站链路超时\n' + output);
  };
  const cleanup = async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.send('shutdown', () => {});
      const [code] = await withTimeout(exited, 7000);
      assert.equal(code, 0, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      for (const socket of ws.clients) socket.terminate();
      await new Promise(done => ws.close(done)); http.closeAllConnections(); await new Promise(done => http.close(done));
      await rm(root, { recursive: true, force: true });
    }
  };
  let socket;
  try { [socket] = await withTimeout(connection, 7000); }
  catch (error) { await cleanup().catch(() => {}); throw error; }
  return {
    sent, states, until, cleanup, get posts() { return posts; }, get output() { return output; },
    send(text, user = 20001) { socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', time: Math.floor(Date.now() / 1000), self_id: 10000, user_id: user, message_id: sequence++, sender: { nickname: '测试' }, message: text })); },
    notice(event) { socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_increase', self_id: 10000, user_id: 20001, ...event })); },
    burst(send) { socket._socket.cork(); try { send(); } finally { socket._socket.uncork(); } },
    prompts: async () => readFile(promptsPath, 'utf8').then(raw => raw.trim().split('\n').filter(Boolean).map(JSON.parse), () => []),
    archive: async () => await readSocialData(join(root,'social.json')),
  };
}

test('真实桥接在归档之前限制消息突发，聚合仍完整且不同会话获得容量', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    f.burst(() => {
      f.send('准入的前半句'); f.send('准入的后半句');
      for (let i = 0; i < 6; i++) f.send('超额旁句' + i);
      f.send('另一个会话', 20002);
    });
    await f.until(async () => (await f.prompts()).length === 2 && f.sent.filter(r => !r.message.includes('这条还没接上')).length === 2);
    const incoming = (await f.archive()).messages.filter(m => !m.self);
    assert.equal(incoming.length, 3); assert.ok(!incoming.some(m => m.text.includes('超额旁句')));
    const prompt = (await f.prompts()).find(p => p.text.includes('准入的前半句'));
    assert.match(prompt.text, /准入的后半句/); assert.doesNotMatch(prompt.text, /另一个会话|超额旁句/);
    assert.equal(f.sent.filter(r => r.user_id === 20001 && r.message.includes('这条还没接上')).length, 1);
    await f.until(() => f.states.some(s => s.ingressDropped === 6 && s.pendingIngress === 0 && s.pendingIngressBytes === 0));
  } finally { await f.cleanup(); }
});

test('聚合独立限制字节，不把超限内容送入模型，结束后释放所有预算', { timeout: 20000 }, async () => {
  const f = await fixture({}, { BATCH_MAX_BYTES: '1024' });
  try {
    f.send('A'.repeat(600)); f.send('B'.repeat(600));
    await f.until(async () => (await f.prompts()).length === 1 && f.sent.length === 2);
    const [prompt] = await f.prompts(); assert.match(prompt.text, /A{600}/); assert.doesNotMatch(prompt.text, /B{600}/);
    await f.until(() => f.states.some(s => s.ingressDropped === 1 && s.pendingIngress === 0 && s.pendingIngressBytes === 0));
    f.send('预算释放后可以恢复'); await f.until(async () => (await f.prompts()).length === 2);
  } finally { await f.cleanup(); }
});

test('归档与聚合容量满时管理员确认优先处理，停止可排空未完成聚合', { timeout: 25000 }, async () => {
  const f = await fixture({ approval: { adminQq: 12345, timeoutMs: 5000 }, features: { qzone: { enabled: true, requireConfirm: true } } }, { FAKE_GROUP_PROMPTS: '' });
  try {
    f.send('MCP空间',12345);
    await f.until(() => f.sent.some(r => r.user_id === 12345 && /授权请求 #/.test(r.message)));
    const approval = f.sent.find(r => r.user_id === 12345 && /授权请求 #/.test(r.message));
    const id = /授权请求 #([a-f0-9]{6})/.exec(approval.message)[1];
    for (let i = 0; i < 3; i++) f.send('占满入站容量', 21000 + i);
    f.send('这个请求超额', 21004);
    f.send('y ' + id, 12345);
    await f.until(() => f.posts === 1 && f.sent.some(r => r.user_id === 12345 && r.message.includes('已允许')));
    assert.match(f.output, /\[ingress\] private:21004 rejected/);
    assert.doesNotMatch(f.output, /\[ingress\] private:12345 rejected/);
  } finally { await f.cleanup(); }
});

test('QQ 通知同样受入站容量与元数据大小限制，普通通知给直接对话留出位置', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.until(() => f.states.some(s => s.qqOnline));
    f.burst(() => {
      f.notice({ group_id: 30000, content: 'x'.repeat(16 * 1024) });
      f.notice({ group_id: 30001 }); f.notice({ group_id: 30002 }); f.notice({ group_id: 30003 });
      f.send('通知拥堵时的直接对话');
    });
    await f.until(async () => (await f.prompts()).length === 1 && f.sent.length === 1);
    assert.match((await f.prompts())[0].text, /通知拥堵时的直接对话/);
    assert.equal((await f.archive()).events.length, 2);
    await f.until(() => f.states.some(s => s.noticesDropped === 2 && s.pendingIngress === 0));
    f.burst(() => {
      f.notice({ group_id: 30010 }); f.notice({ group_id: 30011 }); f.notice({ group_id: 30012 });
      f.notice({ group_id: 30013, notice_type: 'group_recall', message_id: 42 });
    });
    await f.until(async () => (await f.archive()).events.length === 5);
    assert.ok((await f.archive()).events.some(e => e.type.includes('group_recall')));
  } finally { await f.cleanup(); }
});
