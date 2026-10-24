import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

test('桌面配置：中文往返、完整设置校验、无效保存保留文件、工作区切换保护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-desktop-config-'));
  const worker = (action, data) => new Promise((done, reject) => {
    const child = fork(resolve('desktop/config-worker.mjs'), [], { cwd: root, silent: true, execArgv: [], env: { ...process.env, BOT_SETTINGS_FILE: join(root, 'bot.config.json'), BOT_WORKSPACE: root } });
    let reply; child.once('message', value => { reply = value; }); child.once('exit', () => done(reply)); child.once('error', reject); child.send({ action, data });
  });
  try {
    let response = await worker('load'); assert.equal(response.ok, true);
    const settings = response.result.settings; settings.identity.name = '小鲸';
    assert.equal((await worker('settings', settings)).ok, true);
    const before = await readFile(join(root, 'bot.config.json'), 'utf8');
    settings.chat.delay.minMs = 9999; settings.chat.delay.maxMs = 1;
    assert.equal((await worker('settings', settings)).ok, false);
    assert.equal(await readFile(join(root, 'bot.config.json'), 'utf8'), before);
    assert.equal((await worker('persona', { path: join(root, 'AGENTS.md'), text: '你是一只快乐的小鲸。' })).ok, true);
    assert.equal((await worker('load')).result.persona, '你是一只快乐的小鲸。');
    assert.equal((await worker('persona', { path: join(root, 'wrong/AGENTS.md'), text: 'wrong' })).ok, false);
    assert.equal((await worker('env', 'ONEBOT_HTTP_URL=file:///wrong')).ok, false);
    assert.equal((await worker('env', '# 中文配置\nONEBOT_HTTP_URL=http://127.0.0.1:3000\n')).ok, true);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('桌面控制：重复启动不重复建进程，停止发送 graceful IPC，退出清理两个受管进程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-desktop-host-'));
  for (const dir of ['desktop', 'dist', 'scripts']) await mkdir(join(root, dir));
  await cp(resolve('desktop/host.mjs'), join(root, 'desktop/host.mjs'));
  await writeFile(join(root, 'dist/bridge.js'), "console.log('bridge-started'); process.on('message', m => { if (m === 'shutdown') { console.log('graceful-stop'); process.exit(); } }); setInterval(() => {}, 1000);");
  await writeFile(join(root, 'scripts/napcat-node.mjs'), "console.log('napcat-started'); setInterval(() => {}, 1000);");
  const child = spawn(process.execPath, [join(root, 'desktop/host.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = []; createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));
  const wait = async predicate => { const until = Date.now() + 12000; while (!predicate()) { if (Date.now() > until) throw new Error('等待状态超时'); await new Promise(r => setTimeout(r, 30)); } };
  const send = action => child.stdin.write(JSON.stringify({ action }) + '\n');
  try {
    send('start'); await wait(() => events.filter(e => e.type === 'log' && e.text.includes('-started')).length === 2);
    send('start'); send('stop'); await wait(() => events.some(e => e.type === 'log' && e.text.includes('graceful-stop')) && events.at(-1)?.type === 'state' && !events.at(-1).bridge && !events.at(-1).napcat && !events.at(-1).busy);
    assert.equal(events.filter(e => e.type === 'log' && e.text.includes('bridge-started')).length, 1);
    assert.ok(events.some(e => e.type === 'log' && e.text.includes('graceful-stop')));
    send('start'); await wait(() => events.filter(e => e.type === 'log' && e.text.includes('-started')).length === 4);
    send('quit'); await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(events.at(-1).bridge, false); assert.equal(events.at(-1).napcat, false);
  } finally { child.stdin.end(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
