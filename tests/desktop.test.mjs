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
    assert.equal((await worker('runtime', { BOT_DSH_BIN: 'D:\\DeepSeek Harness\\dsh.cmd', ONEBOT_TOKEN: 'local-test-token', MAX_CONCURRENT_TURNS: '4' })).ok, true);
    response = await worker('load');
    assert.equal(response.result.runtimeFields.find(f => f.key === 'BOT_DSH_BIN').value, 'D:\\DeepSeek Harness\\dsh.cmd');
    assert.match(response.result.env, /# 中文配置/);
    const envBefore = response.result.env;
    assert.equal((await worker('runtime', { MAX_CONCURRENT_TURNS: '999' })).ok, false);
    assert.equal((await worker('runtime', { BOT_DSH_PROFILE: 'acp & command' })).ok, false);
    assert.equal((await worker('load')).result.env, envBefore);
    assert.equal((await worker('runtime', { BOT_GROUP_CONTEXT_STORE: '', BOT_USAGE_STORE: '' })).ok, true);
    assert.ok(!(await worker('load')).result.env.includes('BOT_USAGE_STORE=""'));
    assert.equal((await worker('runtime', { BOT_QQ_DIR: 'C:\\new\\napcat' })).ok, true);
    assert.equal((await worker('load')).result.runtimeFields.find(f => f.key === 'BOT_QQ_DIR').value, 'C:\\new\\napcat');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('桌面控制：重复启动不重复建进程，停止发送 graceful IPC，退出清理两个受管进程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-desktop-host-'));
  for (const dir of ['desktop', 'dist', 'scripts']) await mkdir(join(root, dir));
  await cp(resolve('desktop/host.mjs'), join(root, 'desktop/host.mjs'));
  await writeFile(join(root, 'desktop/diagnostics.mjs'), "export async function diagnose(){return {ok:true,rows:[]}}; export async function environment(){return {ONEBOT_TOKEN:'secret-test-token'}}; export async function onebotOnline(){return false};");
  await writeFile(join(root, 'dist/bridge.js'), "console.log('bridge-started'); console.log('token=secret-test-token'); process.on('message', m => { if (m === 'shutdown') { console.log('graceful-stop'); process.exit(); } }); setInterval(() => {}, 1000);");
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
    send('restartBridge'); await wait(() => events.filter(e => e.type === 'log' && e.text.includes('bridge-started')).length === 3);
    assert.equal(events.filter(e => e.type === 'log' && e.text.includes('napcat-started')).length, 2);
    send('quit'); await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(events.at(-1).bridge, false); assert.equal(events.at(-1).napcat, false);
    assert.ok(!JSON.stringify(events).includes('secret-test-token'));
    assert.ok(!(await readFile(join(root, 'data/desktop/console.log'), 'utf8')).includes('secret-test-token'));
  } finally { child.stdin.end(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('启动诊断识别缺失运行依赖，不把进程启动误判成连接成功', async () => {
  const { diagnose } = await import('../desktop/diagnostics.mjs');
  const root = await mkdtemp(join(tmpdir(), 'qq-desktop-check-'));
  try {
    const result = await diagnose(root);
    assert.equal(result.ok, false);
    assert.ok(result.rows.some(row => row.name === '机器人构建文件' && !row.ok));
    assert.ok(result.rows.some(row => row.name === 'NapCat Node 适配库' && !row.ok));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
