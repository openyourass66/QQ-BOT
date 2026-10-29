import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngressBudget } from '../dist/core/ingress.js';
import { MESSAGE_LIMITS, parseMessageEvent } from '../dist/qq/onebot.js';

test('入站按会话、全局条数和 UTF-8 载荷限制，拒绝后不占用容量', async () => {
  const budget = new IngressBudget({ maxPerKey: 2, maxTotal: 3, maxBytes: 10 });
  const a = budget.reserve('a', 3), b = budget.reserve('a', 3);
  assert.ok(a && b);
  assert.equal(budget.reserve('a', 0), undefined);
  assert.equal(budget.reserve('b', 5), undefined);
  const c = budget.reserve('b', 4); assert.ok(c);
  assert.equal(budget.reserve('c', 0), undefined);
  assert.equal(budget.size, 3); assert.equal(budget.pendingBytes, 10);
  a.release(); a.release();
  assert.equal(budget.size, 2); assert.equal(budget.pendingBytes, 7);
  b.release(); c.release(); await budget.drain();
  assert.equal(budget.size, 0); assert.equal(budget.pendingBytes, 0);
  const recovered = budget.reserve('a', 10); assert.ok(recovered); recovered.release();
});

test('关闭入站后拒绝新任务，排空等待实际持有者释放，聚合可转交释放责任', async () => {
  const changes = [];
  const budget = new IngressBudget({ maxPerKey: 2, maxTotal: 2, maxBytes: 100, onChange: (n, b) => changes.push([n, b]) });
  const first = budget.reserve('a', 10), second = budget.reserve('a', 20);
  const batchReleases = [first.release, second.release];
  let drained = false; const waiting = budget.drain().then(() => { drained = true; });
  budget.close(); assert.equal(budget.reserve('b', 1), undefined);
  batchReleases[0](); await Promise.resolve(); assert.equal(drained, false);
  batchReleases[1](); await waiting; assert.deepEqual(changes.at(-1), [0, 0]);
});

test('普通旁聊不能占满为直接对话预留的条数与字节', () => {
  const budget = new IngressBudget({ maxPerKey: 4, maxTotal: 4, maxBytes: 100, reservedFraction: 0.5 });
  const a = budget.reserve('a', 25), b = budget.reserve('a', 25); assert.ok(a && b);
  assert.equal(budget.reserve('a', 0), undefined);
  assert.equal(budget.reserve('b', 1), undefined);
  const direct = budget.reserve('a', 50, true); assert.ok(direct);
  assert.equal(budget.pendingBytes, 100); assert.equal(budget.reserve('b', 1, true), undefined);
  a.release(); b.release(); direct.release(); assert.equal(budget.size, 0);
});

test('入站容量和消息大小拒绝无效、负数及非安全整数', () => {
  for (const value of [0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new IngressBudget({ maxPerKey: value, maxTotal: 2, maxBytes: 10 }));
  }
  const budget = new IngressBudget({ maxPerKey: 1, maxTotal: 1, maxBytes: 10 });
  for (const size of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => budget.reserve('a', size));
});

const message = content => ({
  post_type: 'message', message_type: 'private', time: 0, self_id: 10000, user_id: 20001,
  message_id: -42, message: content, sender: { nickname: '测试' },
});

test('超大消息在 schema 遍历之前拒绝，正文不截断，负消息编号仍有效', () => {
  const text = 'x'.repeat(MESSAGE_LIMITS.textBytes);
  assert.equal(parseMessageEvent(message(text)).message[0].data.text, text);
  assert.equal(parseMessageEvent(message(text + 'x')), undefined);
  assert.equal(parseMessageEvent(message('鲸'.repeat(Math.floor(MESSAGE_LIMITS.textBytes / 3) + 1))), undefined);
  const segments = Array.from({ length: MESSAGE_LIMITS.segments }, () => ({ type: 'text', data: { text: 'x' } }));
  assert.equal(parseMessageEvent(message(segments)).message.length, MESSAGE_LIMITS.segments);
  const excessive = new Array(MESSAGE_LIMITS.segments + 1);
  Object.defineProperty(excessive, 0, { get() { assert.fail('超限集合不应被遍历'); } });
  assert.equal(parseMessageEvent(message(excessive)), undefined);
  assert.equal(parseMessageEvent(message('[CQ:face,id=1]'.repeat(MESSAGE_LIMITS.segments + 1))), undefined);
  assert.equal(parseMessageEvent({ ...message('hello'), metadata: 'x'.repeat(MESSAGE_LIMITS.eventBytes) }), undefined);
  assert.equal(parseMessageEvent(message([{ type: 'text', data: { text: 123 } }])), undefined);
});
