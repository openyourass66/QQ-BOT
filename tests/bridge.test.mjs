import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { withTimeout } from '../dist/runtime.js';

test('完整桥接链路：群上下文、连续回复顺序、超时恢复、DSH 退出清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-bridge-'));
  const replies = [];
  let nextMessage = 1;
  let child;
  let output = '';
  const replyWaiters = new Set();
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body || '{}');
    let data = {};
    if (req.url === '/get_login_info') data = { user_id: 10000, nickname: 'test' };
    if (req.url === '/send_private_msg' || req.url === '/send_group_msg') {
      replies.push(params);
      for (const check of replyWaiters) check();
      data = { message_id: nextMessage++ };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  const wsServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const socketReady = once(wsServer, 'connection');
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  if (!wsServer.address()) await once(wsServer, 'listening');
  const waitReply = async (predicate) => {
    let check;
    try {
      return await withTimeout(new Promise((resolveReply) => {
        check = () => {
          const found = replies.find(predicate);
          if (found) resolveReply(found);
        };
        replyWaiters.add(check);
        check();
      }), 8000);
    } finally { replyWaiters.delete(check); }
  };
  try {
    const fake = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
    const wrapper = join(dir, process.platform === 'win32' ? 'fake dsh.cmd' : 'fake-dsh');
    await writeFile(wrapper, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fake}"\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o700 });
    const settings = join(dir, 'settings.json');
    await writeFile(settings, JSON.stringify({ chat: {
      group: { requireMention: false, contextLines: 0, cooldownMs: 0 },
      delay: { minMs: 0, maxMs: 0, chunkSize: 100 },
    } }));
    child = spawn(process.execPath, [resolve('dist/bridge.js')], {
      windowsHide: true,
      env: { ...process.env,
        ONEBOT_HTTP_URL: `http://127.0.0.1:${http.address().port}`,
        ONEBOT_WS_URL: `ws://127.0.0.1:${wsServer.address().port}`,
        ONEBOT_TOKEN: '', BOT_SELF_ID: '10000', ADMIN_QQ: '0', ALLOW_EXEC: '0',
        BOT_DSH_BIN: wrapper, BOT_WORKSPACE: dir, BOT_DSH_PROFILE: 'acp',
        BOT_SETTINGS_FILE: settings, SESSION_STORE: join(dir, 'sessions.json'),
        TURN_TIMEOUT_MS: '1000', ADMIN_UI_PORT: '0', ADMIN_UI_TOKEN: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = once(child, 'exit');
    const [socket] = await withTimeout(socketReady, 8000);
    const send = (text, group = false) => socket.send(JSON.stringify({
      post_type: 'message', message_type: group ? 'group' : 'private',
      time: 0, self_id: 10000, user_id: 20001, message_id: nextMessage++,
      ...(group ? { group_id: 30001 } : {}),
      raw_message: text, message: [{ type: 'text', data: { text } }],
      sender: { user_id: 20001, nickname: '测试' },
    }));
    send('群聊测试', true);
    const group = await waitReply((r) => r.group_id === 30001);
    assert.match(group.message, /最近的群聊：\n\(暂无\)/);
    assert.equal(group.message.split('群聊测试').length - 1, 1);

    send(`长消息${'甲'.repeat(170)}`);
    send('第二条');
    await waitReply((r) => r.message.includes('第二条'));
    const privateReplies = replies.filter((r) => r.user_id === 20001);
    assert.equal(privateReplies.length, 3);
    assert.match(privateReplies[0].message, /长消息/);
    assert.match(privateReplies[1].message, /甲/);
    assert.match(privateReplies[2].message, /第二条/);

    send('测试超时');
    await waitReply((r) => r.message.includes('走神'));
    send('恢复成功');
    await waitReply((r) => r.message.includes('恢复成功'));
    send('测试崩溃');
    const [code] = await withTimeout(exited, 8000);
    assert.equal(code, 1);
    assert.match(output, /turn timeout/);
  } catch (error) {
    error.message += `\n桥接日志：\n${output}`;
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await withTimeout(once(child, 'exit'), 5000).catch(() => undefined);
    }
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise((done) => wsServer.close(done));
    await new Promise((done) => http.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});
