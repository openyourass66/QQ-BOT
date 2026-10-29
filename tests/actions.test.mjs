import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DailyUsageStore, shanghaiDate } from '../dist/core/usage.js';
import { QqActionPolicy } from '../dist/qq/qq-actions.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';
import { startActionServer } from '../dist/services/action-server.js';

const signal = () => new AbortController().signal;
const like = { action: 'like', user_id: 12345, times: 1 };
const post = { action: 'qzone_post', text: '待确认正文', images: ['https://example.test/image.png'] };
const message = { action: 'send_message', target_type: 'private', target_id: 12345, text: '主动消息' };

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-actions-'));
  const path = join(dir, 'usage.json');
  const settings = structuredClone(DEFAULT_SETTINGS);
  let now = new Date('2026-10-23T15:59:59Z');
  const usage = new DailyUsageStore(path, () => now);
  await usage.load();
  const calls = [];
  const api = {
    async call(action, params, abort) {
      abort?.throwIfAborted();
      calls.push({ action, params });
      return { message_id: calls.length };
    },
    sendPrivate(user_id, text, abort) { return this.call('send_private_msg', { user_id, text }, abort); },
    sendGroup(group_id, text, abort) { return this.call('send_group_msg', { group_id, text }, abort); },
  };
  const makePolicy = (confirm = async () => true) => new QqActionPolicy(api, usage, () => settings, confirm);
  try { await run({ dir, path, usage, settings, api, calls, makePolicy, setNow: (next) => { now = next; } }); }
  finally { await usage.flush(); await rm(dir, { recursive: true, force: true }); }
}

test('空间执行方式与发布确认合并一次正文审批，关闭单独确认仍保留敏感动作审批',()=>fixture(async({settings,makePolicy,calls})=>{
  settings.features.qzone.enabled=true;settings.features.qzone.dailyLimit=3;settings.social.autonomy='confirm';
  let confirmations=0;const policy=makePolicy(async title=>{confirmations++;assert.match(title,/待确认正文/);return true;});
  await policy.execute(post,signal());assert.equal(confirmations,1);
  settings.features.qzone.requireConfirm=false;settings.social.autonomy='sensitive';
  await policy.execute(post,signal());
  assert.equal(confirmations,2);assert.equal(calls.length,2);
}));

test('空间默认关闭；确认拒绝或取消不发布、不扣额度', () => fixture(async ({ makePolicy, settings, calls, path }) => {
  let confirmations = 0;
  const policy = makePolicy(async () => { confirmations++; return false; });
  await assert.rejects(policy.execute(post, signal()), /已关闭/);
  assert.equal(confirmations, 0);
  settings.features.qzone.enabled = true;
  await assert.rejects(policy.execute(post, signal()), /未获管理员确认/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(policy.execute(post, controller.signal));
  assert.equal(confirmations, 1);
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
}));

test('空间审批展示实际正文与图片；审批后重新校验功能开关', () => fixture(async ({ makePolicy, settings, calls }) => {
  settings.features.qzone.enabled = true;
  const policy = makePolicy(async (title) => {
    assert.match(title, /待确认正文/);
    assert.match(title, /https:\/\/example.test\/image.png/);
    return true;
  });
  await policy.execute(post, signal());
  assert.deepEqual(calls[0], { action: 'send_qzone_msg', params: { content: post.text, images: post.images } });
  await assert.rejects(policy.execute(post, signal()), /额度不足/);
  const changed = makePolicy(async () => { settings.features.qzone.enabled = false; return true; });
  await assert.rejects(changed.execute(post, signal()), /已关闭/);
  assert.equal(calls.length, 1);
}));

test('并发点赞按次数共用额度；重启仍保留计数；上海零点重置', () => fixture(async ({ makePolicy, settings, calls, usage, path, setNow }) => {
  settings.budgets.likesPerDay = 20;
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => makePolicy().execute({ ...like, times: 3 }, signal())));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 6);
  assert.equal(calls.length, 6);
  await usage.flush();
  const restored = new DailyUsageStore(path, () => new Date('2026-10-23T15:59:59Z'));
  await restored.load();
  await assert.rejects(restored.consume(() => [{ key: 'likes', amount: 3, limit: 20, label: '点赞' }]), /额度不足/);
  assert.equal(shanghaiDate(new Date('2026-10-23T15:59:59Z')), '2026-10-23');
  assert.equal(shanghaiDate(new Date('2026-10-23T16:00:00Z')), '2026-10-24');
  setNow(new Date('2026-10-23T16:00:00Z'));
  await makePolicy().execute({ ...like, times: 20 }, signal());
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.date, '2026-10-24');
  assert.equal(saved.counters.likes, 20);
}));

test('群主动发言开关、全局额度与单群额度同时生效，拒绝不消耗其他额度', () => fixture(async ({ makePolicy, settings, calls }) => {
  const policy = makePolicy();
  const group = { ...message, target_type: 'group', target_id: 30001 };
  settings.budgets.proactiveMessagesPerDay = 3;
  await assert.rejects(policy.execute(group, signal()), /已关闭/);
  settings.chat.group.proactive.enabled = true;
  await policy.execute(group, signal());
  await assert.rejects(policy.execute(group, signal()), /该群主动消息今日额度不足/);
  await policy.execute({ ...group, target_id: 30002 }, signal());
  await policy.execute(message, signal());
  await assert.rejects(policy.execute(message, signal()), /主动消息今日额度不足/);
  assert.equal(calls.length, 3);
}));

test('额度写入失败时不请求远端；远端失败保留已扣额度；损坏文件不覆盖', () => fixture(async ({ makePolicy, settings, calls, api, path }) => {
  settings.budgets.likesPerDay = 1;
  const policy = makePolicy();
  await mkdir(path);
  await assert.rejects(policy.execute(like, signal()));
  assert.equal(calls.length, 0);
  await rmdir(path);
  api.call = async () => { calls.push('failed'); throw new Error('结果未知'); };
  await assert.rejects(policy.execute(like, signal()), /结果未知/);
  await assert.rejects(policy.execute(like, signal()), /额度不足/);
  assert.equal(calls.length, 1);
  await writeFile(path, '{broken');
  await assert.rejects(new DailyUsageStore(path).load());
  assert.equal(await readFile(path, 'utf8'), '{broken');
}));

test('取消中的空间审批不会发布；参数不能自报 confirmed 绕过确认', () => fixture(async ({ makePolicy, settings, calls }) => {
  settings.features.qzone.enabled = true;
  const controller = new AbortController();
  const policy = makePolicy(async () => { controller.abort(); return true; });
  await assert.rejects(policy.execute(post, controller.signal));
  await assert.rejects(policy.execute({ ...post, confirmed: true }, signal()));
  assert.equal(calls.length, 0);
}));

test('真实 MCP 子进程共用桥接额度，鉴权失败及未知动作不触发远端', () => fixture(async ({ makePolicy, settings, calls }) => {
  settings.budgets.likesPerDay = 1;
  const policy = makePolicy();
  const traces=[];
  const service = await startActionServer((input, abort,_conversation,operationId) => {traces.push(operationId);return policy.execute(input, abort);});
  const clients = [];
  try {
    assert.equal((await fetch(`${service.url}/actions`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${service.url}/actions`, {
      method: 'POST', headers: { authorization: `Bearer ${service.token}` }, body: JSON.stringify({ action: 'unknown' }),
    })).status, 400);
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `test-${i}`, version: '1' });
      clients.push(client);
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [resolve('dist/mcp-qq.js')], stderr: 'pipe',
        env: { BOT_ACTION_URL: service.url, BOT_ACTION_TOKEN: service.token },
      }));
    }
    const results = await Promise.all(clients.map((client) => client.callTool({ name: 'qq_like', arguments: { user_id: 12345 } })));
    const sdkTraces=traces.filter(Boolean);assert.equal(sdkTraces.length,2);assert.ok(sdkTraces.every(id=>/^[a-f0-9]{64}$/.test(id)));assert.notEqual(sdkTraces[0],sdkTraces[1]);
    assert.equal(results.filter((result) => result.isError === true).length, 1);
    assert.match(JSON.stringify(results), /额度不足/);
    assert.equal(calls.length, 1);
    assert.equal((await clients[0].callTool({ name: 'qq_qzone_post', arguments: { text: '禁用' } })).isError, true);
    assert.equal(calls.length, 1);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await service.close();
  }
}));

test('关闭动作服务会取消待审批请求', async () => {
  let entered;
  const executing = new Promise((resolve) => { entered = resolve; });
  let cancelled = false;
  const service = await startActionServer(async (_input, abort) => {
    await new Promise((resolve) => {
      abort.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true });
      entered();
    });
    abort.throwIfAborted();
  });
  const request = fetch(`${service.url}/actions`, {
    method: 'POST', headers: { authorization: `Bearer ${service.token}` }, body: '{}',
  }).catch(() => undefined);
  await executing;
  await service.close();
  await request;
  assert.equal(cancelled, true);
});

test('动作 HTTP 接口在读取请求前拒绝错误编号并限制三十二个活动请求',async()=>{
  let release;const gate=new Promise(done=>{release=done;});let entered=0;
  const service=await startActionServer(async()=>{entered++;await gate;return {done:true};}),headers={authorization:`Bearer ${service.token}`,'content-type':'application/json','x-bot-operation':'a'.repeat(64)},requests=[];
  try{
    assert.equal((await fetch(`${service.url}/actions`,{method:'POST',headers:{...headers,'x-bot-operation':'invalid'},body:'{}'})).status,400);assert.equal(entered,0);
    for(let i=0;i<32;i++)requests.push(fetch(`${service.url}/actions`,{method:'POST',headers,body:'{}'}));
    const end=Date.now()+5000;while(entered<32){if(Date.now()>end)throw new Error('并发请求没有就绪');await new Promise(done=>setTimeout(done,10));}
    assert.equal((await fetch(`${service.url}/actions`,{method:'POST',headers,body:'{}'})).status,429);assert.equal(entered,32);release();assert.ok((await Promise.all(requests)).every(response=>response.status===200));
  }finally{release();await Promise.allSettled(requests);await service.close();}
});
