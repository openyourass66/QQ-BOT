import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup } from '../scripts/setup.mjs';

test('首次初始化创建示例配置与默认人设，再次初始化保留个人内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-setup-'));
  try {
    await mkdir(join(root, 'templates'));
    await writeFile(join(root, '.env.example'), 'BOT_WORKSPACE=bot-workspace\n');
    await writeFile(join(root, 'templates/bot-persona.md'), '默认人设');
    assert.deepEqual(await setup(root), ['.env', 'bot-workspace/AGENTS.md']);
    assert.equal(await readFile(join(root, 'bot-workspace/AGENTS.md'), 'utf8'), '默认人设');
    await writeFile(join(root, '.env'), 'PRIVATE_VALUE=personal\n');
    await writeFile(join(root, 'bot-workspace/AGENTS.md'), '个人修改');
    assert.deepEqual(await setup(root), []);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'PRIVATE_VALUE=personal\n');
    assert.equal(await readFile(join(root, 'bot-workspace/AGENTS.md'), 'utf8'), '个人修改');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('相对工作区解析为 ACP 所需的绝对路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-workspace-'));
  try {
    const url = new URL('../dist/core/config.js', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const {config}=await import(${JSON.stringify(url)});process.stdout.write(config.dsh.workspace);`], {
      cwd: root, env: { ...process.env, BOT_WORKSPACE: 'bot-workspace' }, encoding: 'utf8',
    });
    assert.equal(output, join(root, 'bot-workspace'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
