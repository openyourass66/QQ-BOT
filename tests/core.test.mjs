import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { SessionStore } from '../dist/store.js';
import { ConversationQueue, withTimeout } from '../dist/runtime.js';
import { permissionOutcome, parseApprovalReply } from '../dist/permissions.js';
import { OneBotHttp } from '../dist/onebot.js';

test('拒绝审批时不选择允许项；缺失或空选项取消审批', () => {
  const allow = { kind: 'allow_once', optionId: 'yes' };
  const deny = { kind: 'reject_once', optionId: 'no' };
  assert.deepEqual(permissionOutcome([allow], false), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(permissionOutcome([], true), { outcome: { outcome: 'cancelled' } });
  assert.equal(permissionOutcome([allow, deny], false).outcome.optionId, 'no');
  assert.equal(permissionOutcome([allow, deny], true).outcome.optionId, 'yes');
});

test('审批回复完整匹配并支持指定编号', () => {
  assert.equal(parseApprovalReply('yes please'), undefined);
  assert.equal(parseApprovalReply('不要这样'), undefined);
  assert.deepEqual(parseApprovalReply('y #ABC123'), { approved: true, id: 'abc123' });
  assert.deepEqual(parseApprovalReply('拒绝 abc123'), { approved: false, id: 'abc123' });
});

test('同一会话生成与发送不交错；独立会话并行；失败后队列继续', async () => {
  const queue = new ConversationQueue();
  const events = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = queue.run('a', async () => {
    events.push('generate1');
    await blocked;
    events.push('send1');
    throw new Error('发送失败');
  });
  const failure = assert.rejects(first, /发送失败/);
  const second = queue.run('a', async () => { events.push('generate2'); events.push('send2'); });
  await queue.run('b', async () => { events.push('other'); });
  assert.deepEqual(events, ['generate1', 'other']);
  release();
  await Promise.all([failure, second]);
  await queue.drain();
  assert.deepEqual(events, ['generate1', 'other', 'send1', 'generate2', 'send2']);
  assert.equal(queue.has('a'), false);
});

test('不响应取消的任务仍按时超时，后续消息可以执行', async () => {
  const queue = new ConversationQueue();
  let cancelled = false;
  await assert.rejects(queue.run('a', () => withTimeout(new Promise(() => {}), 20, () => {
    cancelled = true;
  })), /超时/);
  assert.equal(cancelled, true);
  assert.equal(await queue.run('a', async () => '继续'), '继续');
});

test('持续写入期间的会话变动全部落盘，损坏文件不被覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-store-'));
  try {
    const path = join(dir, 'sessions.json');
    const store = new SessionStore(path);
    await store.load();
    for (let i = 0; i < 100; i++) {
      store.set(`private:${i}`, `session-${i}`);
      if (i % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    store.delete('private:1');
    await store.flush();
    const restored = new SessionStore(path);
    await restored.load();
    assert.deepEqual(restored.list(), store.list());
    await writeFile(path, '{broken');
    await assert.rejects(new SessionStore(path).load());
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('环境变量补齐缺失配置；文件优先；并发保存及多次原子替换可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-settings-'));
  process.env.BOT_SETTINGS_FILE = join(dir, 'nested', 'settings.json');
  process.env.ADMIN_QQ = '12345';
  process.env.ALLOW_EXEC = '1';
  process.env.GROUP_PREFIX = '!';
  const settings = await import('../dist/settings.js');
  let stop = () => {};
  try {
    const initial = await settings.loadSettings();
    assert.equal(initial.approval.adminQq, 12345);
    assert.equal(initial.approval.allowExec, true);
    assert.equal(initial.chat.group.prefix, '!');
    await settings.saveSettings({ approval: { adminQq: 67890 } });
    assert.equal(settings.getSettings().approval.adminQq, 67890);
    const clone = settings.getSettings();
    clone.approval.adminQq = 0;
    assert.equal(settings.getSettings().approval.adminQq, 67890);
    await assert.rejects(settings.saveSettings({ chat: { delay: { minMs: 1000, maxMs: 0 } } }));
    await Promise.all(['一', '二', '三'].map((name) => settings.saveSettings({ identity: { name } })));
    assert.equal(JSON.parse(await readFile(process.env.BOT_SETTINGS_FILE, 'utf8')).identity.name, '三');
    stop = settings.watchSettings();
    for (const name of ['外部一', '外部二']) {
      const changed = withTimeout(new Promise((resolve) => {
        const off = settings.onSettingsChange((next) => {
          if (next.identity.name === name) { off(); resolve(); }
        });
      }), 3000);
      const temp = `${process.env.BOT_SETTINGS_FILE}.external`;
      await writeFile(temp, JSON.stringify({ identity: { name } }));
      await rename(temp, process.env.BOT_SETTINGS_FILE);
      await changed;
    }
    await writeFile(process.env.BOT_SETTINGS_FILE, '{broken');
    await assert.rejects(settings.loadSettings());
    assert.equal(await readFile(process.env.BOT_SETTINGS_FILE, 'utf8'), '{broken');
  } finally { stop(); await rm(dir, { recursive: true, force: true }); }
});

test('OneBot 文本按纯文本发送且 API 错误向上传递', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/bad'
      ? { status: 'failed', retcode: 100, message: '测试失败' }
      : { status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new OneBotHttp(`http://127.0.0.1:${server.address().port}`, 'test-token');
    await api.sendPrivate(123, '[CQ:at,qq=all]');
    assert.equal(requests[0].body.auto_escape, true);
    assert.equal(requests[0].auth, 'Bearer test-token');
    await assert.rejects(api.call('bad'), /测试失败/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
