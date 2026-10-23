import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { OneBotWs, parseMessageEvent } from '../dist/onebot.js';
import { ConversationQueue, QueueFullError, withTimeout } from '../dist/runtime.js';
import { RecentMessages, splitForQq } from '../dist/message-utils.js';

const event = (overrides = {}) => ({
  post_type: 'message', message_type: 'private', time: 0,
  self_id: 10000, user_id: 20001, message_id: 1,
  message: [{ type: 'text', data: { text: 'hello' } }],
  sender: { nickname: '测试' }, ...overrides,
});

test('消息入口拒绝结构错误与缺少群号；允许负消息 ID，补齐可选字段', () => {
  for (const input of [null, {}, event({ message: 'text' }), event({ message: [null] }),
    event({ sender: null }), event({ message_type: 'group' }), event({ user_id: NaN })]) {
    assert.equal(parseMessageEvent(input), undefined);
  }
  const parsed = parseMessageEvent(event({ message_id: -10 }));
  assert.equal(parsed.message_id, -10);
  assert.equal(parsed.raw_message, '');
  assert.equal(parsed.sender.user_id, 20001);
  assert.equal(parseMessageEvent(event({ message_type: 'group', group_id: 30001 })).group_id, 30001);
});

test('去重缓存逐条淘汰，区分账号和会话，并在 TTL 后过期', () => {
  let now = 1000;
  const recent = new RecentMessages(3, 100, () => now);
  for (let i = 1; i <= 4; i++) assert.equal(recent.isDuplicate(event({ message_id: i })), false);
  assert.equal(recent.isDuplicate(event({ message_id: 4 })), true);
  assert.equal(recent.isDuplicate(event({ message_id: 3 })), true);
  assert.equal(recent.isDuplicate(event({ message_id: 2 })), true);
  now += 100;
  assert.equal(recent.isDuplicate(event({ message_id: 4 })), false);
  assert.equal(recent.isDuplicate(event({ message_id: 4, user_id: 20002 })), false);
  assert.equal(recent.isDuplicate(event({ message_id: 4, self_id: 10001 })), false);
});

test('回复分片保留 emoji 代理对，且不超过原有长度限制', () => {
  const text = `aaaaa😀${'测试😀'.repeat(8)}`;
  const chunks = splitForQq(text, 6);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 6 && chunk.isWellFormed()));
  assert.deepEqual(splitForQq('短句。下一句', 4), ['短句。', '下一句']);
});

test('会话容量与全局容量拒绝超额任务；失败后恢复容量', async () => {
  const sizes = [];
  const queue = new ConversationQueue({ maxPerKey: 2, maxTotal: 3, onChange: (size) => sizes.push(size) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.run('a', async () => { await gate; throw new Error('失败'); });
  const rejected = assert.rejects(first, /失败/);
  const second = queue.run('a', async () => 2);
  await assert.rejects(queue.run('a', async () => assert.fail('不应执行')), QueueFullError);
  const third = queue.run('b', async () => { await gate; return 3; });
  await assert.rejects(queue.run('c', async () => assert.fail('不应执行')), QueueFullError);
  assert.equal(queue.size, 3);
  release();
  await Promise.all([rejected, second, third]);
  await queue.drain();
  assert.equal(queue.size, 0);
  assert.equal(sizes.at(-1), 0);
  assert.equal(await queue.run('c', async () => '恢复'), '恢复');
});

test('不同会话受全局并发限制；任务结束后依次移交执行位置', async () => {
  const queue = new ConversationQueue({ maxConcurrent: 2 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  let started = 0;
  const tasks = Array.from({ length: 5 }, (_, index) => queue.run(String(index), async () => {
    started++;
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  release();
  await Promise.all(tasks);
  assert.equal(started, 5);
  assert.equal(peak, 2);
  assert.equal(queue.size, 0);
});

async function socketFixture(options, run) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...options });
  if (!server.address()) await once(server, 'listening');
  const clients = [];
  const connections = [];
  server.on('connection', (socket) => connections.push(socket));
  const makeClient = (extra = {}) => {
    const client = new OneBotWs({
      url: `ws://127.0.0.1:${server.address().port}`, token: 'test-token',
      onEvent: () => {}, reconnectDelayMs: 10, ...extra,
    });
    clients.push(client);
    return client;
  };
  try { await run({ server, connections, makeClient }); }
  finally {
    for (const client of clients) client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('WebSocket 校验消息、同步 QQ 心跳状态，重复 start 不建立额外连接', () => socketFixture({}, async ({ server, connections, makeClient }) => {
  const messages = [];
  const heartbeats = [];
  const logs = [];
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const client = makeClient({
    onEvent: (value) => { messages.push(value); complete(); },
    onHeartbeat: (online) => heartbeats.push(online),
    onLog: (line) => logs.push(line),
  });
  const connected = once(server, 'connection');
  client.start();
  client.start();
  const [socket, req] = await withTimeout(connected, 2000);
  assert.equal(req.headers.authorization, 'Bearer test-token');
  for (const frame of ['{bad', JSON.stringify(event({ sender: null })), JSON.stringify({
    post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false },
  }), JSON.stringify(event())]) socket.send(frame);
  await withTimeout(done, 2000);
  assert.equal(messages.length, 1);
  assert.deepEqual(heartbeats, [false]);
  assert.equal(connections.length, 1);
  assert.ok(logs.some((line) => line.includes('invalid message')));
}));

test('无 pong 的连接会失活并自动重连', () => socketFixture({ autoPong: false }, async ({ server, connections, makeClient }) => {
  const logs = [];
  const client = makeClient({ heartbeatIntervalMs: 20, onLog: (line) => logs.push(line) });
  const first = once(server, 'connection');
  client.start();
  await withTimeout(first, 2000);
  await withTimeout(once(server, 'connection'), 2000);
  assert.equal(connections.length, 2);
  assert.ok(logs.some((line) => line.includes('heartbeat timeout')));
}));

test('正常 pong 保持连接；stop 清理心跳且允许重新 start', () => socketFixture({}, async ({ server, connections, makeClient }) => {
  const client = makeClient({ heartbeatIntervalMs: 20 });
  const first = once(server, 'connection');
  client.start();
  const [socket] = await withTimeout(first, 2000);
  let pings = 0;
  await withTimeout(new Promise((resolve) => socket.on('ping', () => { if (++pings === 3) resolve(); })), 2000);
  assert.equal(connections.length, 1);
  const closed = once(socket, 'close');
  client.stop();
  await withTimeout(closed, 2000);
  const restarted = once(server, 'connection');
  client.start();
  await withTimeout(restarted, 2000);
  assert.equal(connections.length, 2);
}));

test('stop 撤销已安排的断线重连', () => socketFixture({}, async ({ server, connections, makeClient }) => {
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const client = makeClient({ reconnectDelayMs: 30, onState: (online) => { if (!online) disconnected(); } });
  const first = once(server, 'connection');
  client.start();
  const [socket] = await withTimeout(first, 2000);
  socket.terminate();
  await withTimeout(closed, 2000);
  client.stop();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(connections.length, 1);
}));

test('WebSocket 握手无响应时超时并重连', async () => {
  const server = createServer();
  const sockets = new Set();
  let connections = 0;
  let reconnected;
  const connectedAgain = new Promise((resolve) => { reconnected = resolve; });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (++connections === 2) reconnected();
  });
  server.on('upgrade', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const logs = [];
  const client = new OneBotWs({
    url: `ws://127.0.0.1:${server.address().port}`, token: '', onEvent: () => {},
    handshakeTimeoutMs: 25, reconnectDelayMs: 5, onLog: (line) => logs.push(line),
  });
  try {
    client.start();
    await withTimeout(connectedAgain, 2000);
    assert.ok(logs.some((line) => line.includes('Opening handshake has timed out')));
  } finally {
    client.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
