import { mkdtemp, readFile, rm, stat, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SocialStore } from '../dist/qq/social-store.js';

const { values } = parseArgs({ options: {
  sizes: { type: 'string', default: '1000,10000,50000' },
  samples: { type: 'string', default: '10' },
  output: { type: 'string' },
} });
const sizes = values.sizes.split(',').map(Number), samples = Number(values.samples);
if (!sizes.length || sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 50000) || !Number.isSafeInteger(samples) || samples < 3 || samples > 100) throw new Error('sizes 需为 1–50000 的整数列表，samples 需为 3–100');
const source = fileURLToPath(new URL('../src/qq/social-store.ts', import.meta.url));
const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
const tempRoot = await realpath(tmpdir());
const root = await mkdtemp(join(tempRoot, 'qq-store-benchmark-'));
const round = n => Math.round(n * 10) / 10;
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  return { mean: round(values.reduce((a, b) => a + b, 0) / values.length), p50: percentile(0.5), p95: percentile(0.95), max: round(sorted.at(-1)) };
};
const results = [];
try {
  for (const count of sizes) {
    global.gc?.();
    const path = join(root, `social-${count}.json`), store = new SocialStore(path), data = store.snapshot();
    const content = '用于隔离性能评估的模拟聊天内容。'.repeat(12), now = Date.now(), chats = Math.max(1, Math.ceil(count / 2000));
    data.messages = Array.from({ length: count }, (_, i) => ({ chat: `group:${10000 + i % chats}`, id: i + 1, user: 100000 + i % 20, name: '模拟用户', at: now - count * 1000 + i * 1000, text: content, segments: [{ type: 'text', data: { text: content } }], self: false, recalled: false }));
    await writeFile(path, JSON.stringify(data));
    await store.load();
    const snapshots = [];
    for (let i = 0; i < 3; i++) { const start = performance.now(); store.snapshot(); snapshots.push(performance.now() - start); }
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    const records = [];
    try {
      await new Promise(done => setTimeout(done, 20));
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        await store.record({ post_type: 'message', message_type: 'group', self_id: 42, user_id: 43, group_id: 10000, message_id: count + i + 1, time: Math.floor(Date.now() / 1000), raw_message: content, message: [{ type: 'text', data: { text: content } }], sender: { user_id: 43, nickname: '模拟用户' } }, 30, 2000);
        records.push(performance.now() - start);
      }
      await new Promise(done => setTimeout(done, 20));
    } finally { delay.disable(); }
    const result = { requestedMessages: count, retainedMessages: store.snapshot().messages.length, fileMiB: round((await stat(path)).size / 1024 / 1024), samples, snapshotMs: summary(snapshots), recordMs: summary(records), eventLoopMaxMs: round(delay.max / 1e6), rssMiB: round(process.memoryUsage().rss / 1024 / 1024) };
    results.push(result);
    console.error(`${count} 条：record 平均 ${result.recordMs.mean} ms，P95 ${result.recordMs.p95} ms`);
  }
} finally {
  const actual = await realpath(root), rel = relative(tempRoot, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(actual).startsWith('qq-store-benchmark-')) throw new Error('临时基准目录位置异常，已保留');
  await rm(actual, { recursive: true, force: true });
}
const report = { measuredAt: new Date().toISOString(), diagnosticOnly: true, note: '合成数据串行存储诊断；不代表真实 QQ/模型吞吐或完整压力验收。RSS 包含夹具与采样对象。', node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryGiB: round(totalmem() / 1024 ** 3), socialStoreSha256: sourceHash, results };
const json = JSON.stringify(report, null, 2) + '\n';
if (values.output) { const path = resolve(values.output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, json); }
console.log(json);
