import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { withTimeout } from '../dist/runtime.js';

test('群聊链路：连续 @、排队上下文、引用、追问、异常反馈与重启恢复', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-group-'));
  const sent = []; let nextId = 1000, child, socket, output = '';
  const http = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw || '{}'); let data = {};
    if (req.url === '/get_login_info') data = { user_id: 10000, nickname: '小鲸鱼' };
    if (req.url === '/send_group_msg') {
      const messageId = nextId++; sent.push({ ...input, messageId }); data = { message_id: messageId };
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' }); if (!ws.address()) await once(ws, 'listening');
  const settingsFile = join(dir, 'settings.json'), promptsFile = join(dir, 'prompts.jsonl');
  const contextFile = join(dir, 'group-context.json');
  await writeFile(settingsFile, JSON.stringify({ identity: { name: '小鲸鱼' }, chat: { group: { cooldownMs: 60000, contextLines: 30, proactive: { enabled: true } }, delay: { minMs: 0, maxMs: 0, chunkSize: 4000 } } }));
  const fixture = resolve('tests/fixtures/fake-dsh.mjs'), wrapper = join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake-dsh');
  await writeFile(wrapper, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`, { mode: 0o700 });
  const until = async (check) => {
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise((done) => setTimeout(done, 15)); }
    throw new Error(`群聊状态等待超时\n${output}`);
  };
  const idle = () => until(async () => {
    const last = sent.at(-1);
    if (!last) return true;
    try {
      const { groups } = JSON.parse(await readFile(contextFile, 'utf8'));
      return groups[`10000:${last.group_id}`]?.some((entry) => entry.messageId === last.messageId);
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  const prompts = async () => (await readFile(promptsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const start = async () => {
    const connection = once(ws, 'connection');
    child = spawn(process.execPath, [resolve('dist/bridge.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
      ...process.env, BOT_DSH_BIN: wrapper, BOT_WORKSPACE: dir, BOT_SETTINGS_FILE: settingsFile,
      SESSION_STORE: join(dir, 'sessions.json'), BOT_USAGE_STORE: join(dir, 'usage.json'), BOT_GROUP_CONTEXT_STORE: contextFile,
      ONEBOT_HTTP_URL: `http://127.0.0.1:${http.address().port}`, ONEBOT_WS_URL: `ws://127.0.0.1:${ws.address().port}`, ONEBOT_TOKEN: '',
      BOT_SELF_ID: '99999', ADMIN_QQ: '0', TURN_TIMEOUT_MS: '1000',
      QUEUE_PER_CONVERSATION: '3', QUEUE_TOTAL: '10', MAX_CONCURRENT_TURNS: '2', FAKE_GROUP_PROMPTS: promptsFile,
    } });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    [socket] = await withTimeout(connection, 7000);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exit = once(child, 'exit'); child.send('shutdown'); await withTimeout(exit, 7000);
  };
  const send = (message, user = 20001, group = 30001) => {
    const id = nextId++;
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', time: 0, self_id: 10000,
      user_id: user, message_id: id, group_id: group, message,
      sender: { user_id: user, nickname: `群友${user}` },
    })); return id;
  };
  const mention = (text) => [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }];
  try {
    await start();
    const backgroundId = send('背景：先装 Node 再运行项目');
    send(mention('问题甲：怎样运行？'));
    send(mention('问题乙：接着上个答案解释'));
    send('未来的无关发言：下周去游泳');
    await until(() => sent.length >= 2); await idle();
    assert.deepEqual(sent.map((item) => item.message), ['群回答 1', '群回答 2'], '冷却中连续 @ 不应丢弃');
    let requests = await prompts();
    assert.match(requests[0].text, /背景：先装 Node/);
    assert.doesNotMatch(requests[0].text, /未来的无关发言/);
    assert.match(requests[1].text, /问题甲/); assert.match(requests[1].text, /群回答 1/);
    assert.doesNotMatch(requests[1].text, /未来的无关发言/);
    assert.equal(requests[0].sessionId, requests[1].sessionId);

    send([{ type: 'at', data: { qq: '10000' } }]);
    await until(() => sent.length >= 3); await idle();
    send([{ type: 'reply', data: { id: sent[0].messageId } }, { type: 'text', data: { text: '引用甲的回答，能举例吗？' } }], 20002);
    await until(() => sent.length >= 4); await idle();
    requests = await prompts(); assert.match(requests.at(-1).text, /当前发言引用：\[你\].*群回答 1/);
    send('那为什么要这样？', 20002);
    await until(() => sent.length >= 5); await idle();
    assert.match((await prompts()).at(-1).text, /群回答 4/);

    const count = (await prompts()).length;
    send('那为什么要这样？', 20003);
    send([{ type: 'reply', data: { id: backgroundId } }, { type: 'text', data: { text: '那为什么？' } }], 20002);
    send([{ type: 'at', data: { qq: '20003' } }, { type: 'text', data: { text: '那为什么？' } }], 20002);
    // 用一个明确触发作处理屏障，确认前面三个事件没有创建模型轮次。
    send('小鲸鱼，叫名字也要接住');
    await until(() => sent.length >= 6); await idle();
    assert.equal((await prompts()).length, count + 1);

    send('[CQ:at,qq=10000] CQ 格式问题');
    await until(() => sent.length >= 7); await idle();
    send(mention('GROUP_EMPTY'));
    await until(() => sent.length >= 8); await idle();
    assert.match(sent.at(-1).message, /没接明白/);
    send(mention('GROUP_TIMEOUT'));
    await until(() => sent.length >= 9); await idle();
    assert.match(sent.at(-1).message, /没处理成功/);
    send(mention('超时之后继续回答'));
    await until(() => sent.length >= 10); await idle();

    const beforeOverflow = sent.length;
    for (let i = 0; i < 5; i++) send(mention(`容量测试 ${i}`));
    await until(() => sent.length >= beforeOverflow + 4); await idle();
    assert.equal((output.match(/\[queue\] group:30001 rejected;/g) ?? []).length, 2);
    assert.equal(sent.slice(beforeOverflow).filter((item) => item.message.includes('消息有点多')).length, 1);

    await stop();
    const persisted = JSON.parse(await readFile(contextFile, 'utf8')).groups['10000:30001'];
    assert.ok(persisted.some((item) => item.role === 'user' && item.text.includes('问题甲')));
    assert.ok(persisted.some((item) => item.role === 'assistant' && item.text === '群回答 1'));
    const previousSent = sent.length;
    await start();
    send([{ type: 'reply', data: { id: sent[0].messageId } }, { type: 'text', data: { text: '重启后还能接住这句话吗？' } }]);
    await until(() => sent.length > previousSent); await idle();
    assert.match((await prompts()).at(-1).text, /当前发言引用：\[你\].*群回答 1/);
    // 群号隔离，即使成员相同也不能带入另一个群的上下文。
    send(mention('另一个群的问题'), 20001, 30002);
    await until(() => sent.some((item) => item.group_id === 30002)); await idle();
    assert.doesNotMatch((await prompts()).at(-1).text, /重启后还能接住这句话/);
    const beforeTool = sent.length;
    send(mention('GROUP_TOOL_ONLY'));
    await until(() => sent.length > beforeTool); await idle();
    assert.equal(sent.length, beforeTool + 1, '工具已成功发送时不能再因空模型文本补发兜底');
    assert.equal(sent.at(-1).message, '工具发出的群回答');
    send('那为什么是这个答案？');
    await until(() => sent.length > beforeTool + 1); await idle();
    assert.match((await prompts()).at(-1).text, /工具发出的群回答/);
  } catch (error) { error.message += `\n${output}`; throw error; }
  finally {
    await stop();
    for (const client of ws.clients) client.terminate();
    await new Promise((done) => ws.close(done)); await new Promise((done) => http.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});
