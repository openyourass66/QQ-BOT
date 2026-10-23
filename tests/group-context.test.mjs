import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupContextStore, groupTrigger } from '../dist/group-context.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';

test('群上下文保存双向消息；排队中的提问能看到上一轮回答但看不到未来发言；重启、隔离及重置有效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-context-'));
  try {
    const file = join(dir, 'groups.json');
    let now = 1000;
    const store = new GroupContextStore(file, () => now);
    const record = (id, role = 'user', extra = {}) => store.record(1, 10, { messageId: id, userId: role === 'user' ? 2 : 1, name: role, text: `内容 ${id}`, role, ...extra });
    const a = record(10), b = record(11), future = record(12);
    const answer = record(20, 'assistant', { replyTo: a.seq, targetUserId: 2 });
    assert.deepEqual(store.context(1, 10, a.seq, 20), []);
    assert.deepEqual(store.context(1, 10, b.seq, 20).map((e) => e.messageId), [10, 20]);
    assert.ok(store.context(1, 10, b.seq, 20).every((e) => e.messageId !== future.messageId));
    assert.equal(store.hasReply(1, 10, a.seq), true);
    assert.equal(store.canFollowUp(1, 10, 2, 90000), true);
    assert.equal(store.canFollowUp(1, 10, 3, 90000), false);
    assert.equal(store.canFollowUp(1, 10, 2, 0), false);
    assert.deepEqual(store.context(2, 10, 100, 20), []);
    assert.deepEqual(store.context(1, 11, 100, 20), []);
    // OneBot 自身消息回流，不新增一份回答或抹掉追问的接收者。
    record(20, 'assistant');
    assert.equal(store.find(1, 10, 20).targetUserId, 2);
    assert.equal(store.context(1, 10, b.seq, 20).length, 2);
    await store.flush();
    const restored = new GroupContextStore(file, () => now); await restored.load();
    assert.equal(restored.find(1, 10, answer.messageId).text, '内容 20');
    assert.equal(restored.canFollowUp(1, 10, 2, 90000), true);
    now += 90001;
    assert.equal(restored.canFollowUp(1, 10, 2, 90000), false);
    restored.clear(1, 10); await restored.flush();
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).groups, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('群触发：纯 @、实际账号、叫名字、引用机器人和同人追问；不抢其他人的对话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-trigger-'));
  try {
    let now = 100;
    const store = new GroupContextStore(join(dir, 'groups.json'), () => now);
    const settings = structuredClone(DEFAULT_SETTINGS); settings.identity.name = '小鲸鱼';
    const event = (message, user = 2) => ({ self_id: 1, user_id: user, group_id: 10, message });
    const text = (value) => ({ type: 'text', data: { text: value } });
    const bot = store.record(1, 10, { messageId: 20, userId: 1, name: '小鲸鱼', text: '先装依赖', role: 'assistant', targetUserId: 2 });
    store.record(1, 10, { messageId: 21, userId: 3, name: '其他群友', text: '我的问题', role: 'user' });
    const trigger = (parts, user) => groupTrigger(event(parts, user), settings, store);
    const bare = trigger([{ type: 'at', data: { qq: '1' } }]);
    assert.equal(bare.reason, 'mention'); assert.ok(bare.body.length > 0);
    assert.equal(trigger([text('小鲸鱼，你怎么看')]).reason, 'name');
    assert.equal(trigger([text('@1 你好')]).reason, 'text-mention');
    assert.equal(trigger([text('@123 你好')]).ok, false);
    assert.equal(trigger([{ type: 'reply', data: { id: bot.messageId } }, text('继续说')], 3).reason, 'quote');
    assert.equal(trigger([text('那为什么？')]).reason, 'follow-up');
    assert.equal(trigger([text('那为什么？')], 3).ok, false);
    assert.equal(trigger([{ type: 'reply', data: { id: 21 } }, text('那为什么？')]).ok, false);
    assert.equal(trigger([{ type: 'at', data: { qq: 3 } }, text('那为什么？')]).ok, false);
    now += 90001;
    assert.equal(trigger([text('那为什么？')]).ok, false);
    await store.flush();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('群记录容量与过期淘汰有界；损坏的持久化文件不会被覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-context-bounds-'));
  try {
    const path = join(dir, 'groups.json'); let now = 100;
    const store = new GroupContextStore(path, () => now);
    const add = (group, id) => store.record(1, group, { messageId: id, userId: 2, name: '群友', text: '字'.repeat(3000), role: 'user' });
    for (let i = 0; i < 90; i++) add(1, i);
    assert.equal(store.context(1, 1, 1000, 1000).length, 80);
    assert.equal(store.find(1, 1, 89).text.length, 2000);
    for (let i = 2; i <= 101; i++) add(i, i);
    assert.equal(store.find(1, 1, 89), undefined);
    await store.flush();
    assert.equal(Object.keys(JSON.parse(await readFile(path, 'utf8')).groups).length, 100);
    now += 86400001;
    assert.equal(store.find(1, 101, 101), undefined);
    add(102, 102); await store.flush();
    assert.equal(Object.keys(JSON.parse(await readFile(path, 'utf8')).groups).length, 1);
    await writeFile(path, '{broken');
    await assert.rejects(new GroupContextStore(path).load());
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
