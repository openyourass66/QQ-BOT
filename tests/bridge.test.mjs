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
  let likes = 0;
  let posts = 0;
  let nextMessage = 1;
  let child;
  let output = '';
  let releaseLogin;
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  let adminReadyResolve;
  const adminReady = new Promise((resolve) => { adminReadyResolve = resolve; });
  const replyWaiters = new Set();
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body || '{}');
    let data = {};
    if (req.url === '/get_login_info') {
      await loginGate;
      data = { user_id: 10000, nickname: 'test' };
    }
    if (req.url === '/send_like') likes++;
    if (req.url === '/send_qzone_msg') posts++;
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
  const waitReply = async (predicate, after = 0) => {
    let check;
    try {
      return await withTimeout(new Promise((resolveReply) => {
        check = () => {
          const found = replies.find((reply, index) => index >= after && predicate(reply));
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
    await writeFile(settings, JSON.stringify({
      approval: { adminQq: 12345, timeoutMs: 5000 },
      features: { qzone: { enabled: true, requireConfirm: true } },
      budgets: { likesPerDay: 1 }, chat: {
      group: { requireMention: false, contextLines: 0, cooldownMs: 0 },
      delay: { minMs: 0, maxMs: 0, chunkSize: 100 },
    } }));
    // 首条私聊从已有会话恢复，校验恢复请求也传入新的 MCP 凭据。
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: {
      'private:20001': { sessionId: 'saved-private', updatedAt: Date.now() },
    } }));
    child = spawn(process.execPath, [resolve('dist/bridge.js')], {
      windowsHide: true,
      env: { ...process.env,
        ONEBOT_HTTP_URL: `http://127.0.0.1:${http.address().port}`,
        ONEBOT_WS_URL: `ws://127.0.0.1:${wsServer.address().port}`,
        ONEBOT_TOKEN: '', BOT_SELF_ID: '10000', ADMIN_QQ: '0', ALLOW_EXEC: '0',
        BOT_DSH_BIN: wrapper, BOT_WORKSPACE: dir, BOT_DSH_PROFILE: 'acp',
        BOT_SETTINGS_FILE: settings, SESSION_STORE: join(dir, 'sessions.json'),
        BOT_USAGE_STORE: join(dir, 'daily-usage.json'), BOT_ACTION_TOKEN: '', BOT_ACTION_URL: '',
        TURN_TIMEOUT_MS: '2000', ADMIN_UI_PORT: '0', ADMIN_UI_TOKEN: 'test',
        QUEUE_PER_CONVERSATION: '2', QUEUE_TOTAL: '3', MAX_CONCURRENT_TURNS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /\[admin\] (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) adminReadyResolve(match[1]);
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = once(child, 'exit');
    const [socket] = await withTimeout(socketReady, 8000);
    const adminUrl = await withTimeout(adminReady, 2000);
    const getStatus = async () => (await fetch(`${adminUrl}/api/status`, { headers: { 'x-admin-token': 'test' } })).json();
    const waitStatus = async (predicate) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const current = await getStatus();
        if (predicate(current)) return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('状态没有按预期更新');
    };
    const heartbeat = (online) => socket.send(JSON.stringify({
      post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online },
    }));
    heartbeat(true);
    await waitStatus((status) => status.qqOnline === true);
    heartbeat(false);
    await waitStatus((status) => status.qqOnline === false);
    releaseLogin();
    const loginStatus = await waitStatus((status) => status.nickname === 'test');
    assert.equal(loginStatus.qqOnline, false, '较晚完成的登录查询不能覆盖新的离线心跳');
    heartbeat(true);
    await waitStatus((status) => status.qqOnline === true);
    const send = (text, group = false, userId = 20001) => socket.send(JSON.stringify({
      post_type: 'message', message_type: group ? 'group' : 'private',
      time: 0, self_id: 10000, user_id: userId, message_id: nextMessage++,
      ...(group ? { group_id: 30001 } : {}),
      raw_message: text, message: [{ type: 'text', data: { text } }],
      sender: { user_id: userId, nickname: '测试' },
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

    send('MCP点赞');
    await waitReply((r) => r.message === 'MCP调用成功');
    send('MCP点赞');
    await waitReply((r) => r.message.includes('MCP拒绝:') && r.message.includes('额度不足'));
    assert.equal(likes, 1);

    let after = replies.length;
    send('MCP空间');
    const cancelledApproval = await waitReply((r) => r.user_id === 12345 && r.message.includes('审批正文'), after);
    const cancelledId = /授权请求 #([a-f0-9]{6})/.exec(cancelledApproval.message)[1];
    await waitReply((r) => r.message.includes('走神'), after);
    after = replies.length;
    send('MCP空间');
    const approval = await waitReply((r) => r.user_id === 12345 && r.message.includes('审批正文'), after);
    assert.match(approval.message, /https:\/\/example.test\/picture.png/);
    assert.equal(posts, 0);
    const approvalId = /授权请求 #([a-f0-9]{6})/.exec(approval.message)[1];
    send(`y ${cancelledId}`, false, 12345);
    await waitReply((r) => r.user_id === 12345 && r.message.includes('请带有效的授权编号'), after);
    assert.equal(posts, 0);
    send(`y ${approvalId}`, false, 12345);
    await waitReply((r) => r.message === 'MCP空间成功');
    assert.equal(posts, 1);

    after = replies.length;
    send('测试超时');
    send('排队成功');
    send('溢出一');
    send('溢出二');
    await waitReply((r) => r.message.includes('这条还没接上'), after);
    await waitReply((r) => r.message.includes('走神'), after);
    await waitReply((r) => r.message.includes('排队成功'), after);
    assert.equal(replies.filter((r) => r.message.includes('这条还没接上')).length, 1);
    const status = await getStatus();
    assert.equal(status.messagesDropped, 2);
    assert.equal(status.wsConnected, true);
    assert.ok(status.pendingMessages <= 1);
    send('恢复成功');
    await waitReply((r) => r.message.includes('恢复成功'));
    after = replies.length;
    send('MCP点赞');
    await waitReply((r) => r.message.includes('MCP拒绝:') && r.message.includes('额度不足'), after);
    send('测试崩溃');
    const [code] = await withTimeout(exited, 8000);
    assert.equal(code, 1);
    assert.match(output, /turn timeout/);
  } catch (error) {
    error.message += `\n桥接日志：\n${output}`;
    throw error;
  } finally {
    releaseLogin();
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
