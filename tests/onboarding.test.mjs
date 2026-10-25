import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { detectEnvironment, checkSetup } from '../desktop/onboarding.mjs';
import { validateRuntimeEnv } from '../desktop/runtime-fields.mjs';

test('环境检测仅返回已存在的程序路径，支持 PATH 与运行中的 QQ，不执行程序或泄露凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-detect-'));
  try {
    await mkdir(join(root, 'bin')); await mkdir(join(root, 'qq/versions'), { recursive: true });
    await writeFile(join(root, 'bin/dsh.cmd'), 'not executable'); await writeFile(join(root, 'qq/versions/config.json'), '{}');
    await writeFile(join(root, '.env'), 'KEEP=unchanged\n');
    const result = await detectEnvironment(root, { PATH: join(root, 'bin'), ONEBOT_TOKEN: 'fixture-private-token' }, { platform: 'win32', runningPaths: [join(root, 'qq/QQ.exe')] });
    assert.deepEqual(result.suggestions, [{ key: 'BOT_DSH_BIN', value: join(root, 'bin/dsh.cmd') }, { key: 'BOT_QQ_DIR', value: join(root, 'qq') }]);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-token/);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'KEEP=unchanged\n');
    await mkdir(join(root, 'fake.cmd'));
    assert.equal((await detectEnvironment(root, { BOT_DSH_BIN: 'fake.cmd' }, { runningPaths: [], platform: 'test' })).suggestions.length, 0);
    assert.throws(() => validateRuntimeEnv('BOT_ONEBOT_MODE=unknown'), /接入方式无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('快速检查使用未保存输入，外部服务跳过本机依赖，鉴权错误明确定位，检查不保存配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-setup-check-'));
  const requests = []; let authorized = true;
  const server = createServer((req, res) => { requests.push(req); res.setHeader('content-type', 'application/json'); res.statusCode = authorized ? 200 : 401; res.end(JSON.stringify({ retcode: 0 })); });
  const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/bridge.js'), ''); await writeFile(join(root, 'dsh.cmd'), '');
    const original = 'ONEBOT_HTTP_URL=http://127.0.0.1:1\n'; await writeFile(join(root, '.env'), original);
    const draft = { BOT_DSH_BIN: 'dsh.cmd', BOT_WORKSPACE: '.', BOT_CHAT_MODE: 'profile', BOT_ONEBOT_MODE: 'external', ONEBOT_HTTP_URL: `http://127.0.0.1:${server.address().port}`, ONEBOT_WS_URL: `ws://127.0.0.1:${server.address().port}`, ONEBOT_TOKEN: 'fixture-secret-value' };
    let result = await checkSetup(root, draft); assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.rows.filter(r => ['NapCat Shell','NapCat Node 适配库','QQ 安装目录'].includes(r.name)).every(r => !r.required));
    assert.equal(requests[0].headers.authorization, 'Bearer fixture-secret-value');
    assert.equal(await readFile(join(root, '.env'), 'utf8'), original);
    result = await checkSetup(root, { ...draft, ONEBOT_WS_URL: 'ws://127.0.0.1:1' }); assert.equal(result.ok, false); assert.equal(result.rows.find(r => r.name === 'QQ 消息通道').ok, false);
    authorized = false; result = await checkSetup(root, draft); assert.equal(result.ok, false);
    assert.match(result.rows.find(r => r.name === 'QQ 服务连接').detail, /令牌被拒绝/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret-value/);
    result = await checkSetup(root, { ...draft, BOT_ONEBOT_MODE: 'managed' }); assert.equal(result.ok, false);
    assert.ok(result.rows.find(r => r.name === 'NapCat Shell').required);
  } finally { for (const client of sockets.clients) client.terminate(); await new Promise(done => sockets.close(done)); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); }
});

test('首次桌面读取自动初始化默认配置与人设，再次读取保留个人文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-first-run-'));
  const worker = () => new Promise((done, reject) => {
    const child = fork(resolve('desktop/config-worker.mjs'), [], { cwd: root, silent: true, execArgv: [], env: { ...process.env, BOT_WORKSPACE: '', BOT_SETTINGS_FILE: join(root, 'bot.config.json') } });
    let reply; child.once('message', r => { reply = r; }); child.once('exit', () => done(reply)); child.once('error', reject); child.send({ action: 'load' });
  });
  try {
    await cp(resolve('.env.example'), join(root, '.env.example')); await cp(resolve('templates'), join(root, 'templates'), { recursive: true });
    let response = await worker(); assert.equal(response.ok, true, JSON.stringify(response)); assert.equal(response.result.needsSetup, true);
    assert.match(await readFile(join(root, '.env'), 'utf8'), /BOT_ONEBOT_MODE=auto/);
    const persona = join(root, 'bot-workspace/AGENTS.md'); assert.match(await readFile(persona, 'utf8'), /默认聊天约定/);
    await writeFile(persona, 'Personal persona'); await writeFile(join(root, '.env'), 'BOT_WORKSPACE=bot-workspace\nBOT_DSH_BIN=custom.cmd\n');
    response = await worker(); assert.equal(response.ok, true); assert.equal(response.result.needsSetup, false);
    assert.equal(await readFile(persona, 'utf8'), 'Personal persona'); assert.match(await readFile(join(root, '.env'), 'utf8'), /BOT_DSH_BIN=custom.cmd/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('显式连接已有 QQ 服务时不会误启动本机 NapCat，即使外部服务暂时离线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-external-start-'));
  let child;
  try {
    for (const dir of ['desktop','scripts','dist']) await mkdir(join(root, dir));
    await cp(resolve('desktop/host.mjs'), join(root, 'desktop/host.mjs'));
    await writeFile(join(root, 'desktop/diagnostics.mjs'), "export async function diagnose(){return {ok:true,rows:[]}};export async function environment(){return {BOT_ONEBOT_MODE:'external'}};export async function onebotOnline(){return false}");
    await writeFile(join(root, 'scripts/napcat-node.mjs'), "console.log('unexpected-napcat-start');setInterval(()=>{},1000)");
    await writeFile(join(root, 'dist/bridge.js'), "console.log('external-bridge-start');process.on('message',m=>{if(m==='shutdown')process.exit()});setInterval(()=>{},1000)");
    child = spawn(process.execPath, [join(root, 'desktop/host.mjs')], { stdio: ['pipe','pipe','pipe'] });
    const events = []; createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));
    child.stdin.write(JSON.stringify({ action: 'start' })+'\n');
    const deadline = Date.now()+6000;
    while (!events.some(e => String(e.text).includes('external-bridge-start'))) { assert.ok(Date.now()<deadline, JSON.stringify(events)); await new Promise(done => setTimeout(done, 20)); }
    assert.ok(!events.some(e => String(e.text).includes('unexpected-napcat-start')));
    assert.ok(events.some(e => e.type === 'state' && e.externalNapcat));
    const exit = once(child, 'exit'); child.stdin.write(JSON.stringify({ action: 'quit' })+'\n'); await exit;
  } finally { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
