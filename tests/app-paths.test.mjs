import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { runtimeLayout, prepareRuntime, sameRuntimePath } from '../scripts/app-paths.mjs';
import { validateRuntimeEnv } from '../desktop/runtime-fields.mjs';

const manifest = JSON.stringify({ formatVersion: 1, appId: 'whale-workbench', version: '0.2.0' });
const pause = () => new Promise(done => setTimeout(done, 20));
async function until(check, details) {
  const end = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < end, details()); await pause(); }
}
async function run(file, args, options) {
  const child = spawn(process.execPath, [file, ...args], { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
  const [code] = await once(child, 'exit');
  return { code, output, errors };
}

test('源码目录保持兼容，自定义目录与便携模式明确区分，解析本身不写数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-layout-'));
  try {
    const source = await runtimeLayout({ root, env: {}, cwd: tmpdir() });
    assert.equal(source.dataRoot, await realpath(root)); assert.equal(source.mode, 'source');
    const custom = await runtimeLayout({ root, cwd: root, env: { BOT_DATA_DIR: 'old' }, args: ['--data-dir', '中文 data'] });
    assert.equal(custom.dataRoot, join(source.dataRoot, '中文 data'));
    assert.equal((await runtimeLayout({ root, env: {}, args: ['--portable'] })).dataRoot, join(source.dataRoot, 'user-data'));
    assert.deepEqual(await readdir(root), []);
    for (const args of [['--data-dir'], ['--data-dir',''], ['--bad'], ['--portable','--data-dir','x'], ['--portable','--portable']]) await assert.rejects(runtimeLayout({ root, env: {}, args }));
    await assert.rejects(runtimeLayout({ root, env: { BOT_DATA_DIR: 'x' }, args: ['--portable'] }), /不能同时/);
    assert.throws(() => validateRuntimeEnv('BOT_DATA_DIR=elsewhere\n'), /不能写入 .env/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('发行版从用户目录初始化，覆盖程序版本后仍保留原配置、人设与数据', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-installed-')));
  try {
    const app = join(root, '只读程序'), local = join(root, 'Local AppData');
    await mkdir(join(app, 'templates'), { recursive: true });
    await writeFile(join(app, 'release-manifest.json'), manifest);
    await writeFile(join(app, '.env.example'), 'BOT_WORKSPACE=bot-workspace\n');
    await writeFile(join(app, 'templates/bot-persona.md'), '初始人设');
    const options = { root: app, platform: 'win32', env: { LOCALAPPDATA: local }, cwd: tmpdir() };
    const layout = await prepareRuntime(options);
    assert.equal(layout.dataRoot, join(root, 'Local AppData/WhaleWorkbench'));
    assert.equal(layout.mode, 'installed');
    await writeFile(layout.envFile, 'PRIVATE_VALUE=kept\n');
    await writeFile(join(layout.dataRoot, 'bot-workspace/AGENTS.md'), '个人设置');
    await mkdir(join(layout.dataRoot, 'data')); await writeFile(join(layout.dataRoot, 'data/social.json'), 'original data');
    await writeFile(join(app, '.env.example'), 'changed default');
    await prepareRuntime(options);
    assert.equal(await readFile(layout.envFile, 'utf8'), 'PRIVATE_VALUE=kept\n');
    assert.equal(await readFile(join(layout.dataRoot, 'bot-workspace/AGENTS.md'), 'utf8'), '个人设置');
    assert.equal(await readFile(join(layout.dataRoot, 'data/social.json'), 'utf8'), 'original data');
    assert.deepEqual((await readdir(app)).sort(), ['.env.example','release-manifest.json','templates']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('发行清单损坏或数据目录不可用时明确失败，不回退创建另一份空数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-layout-invalid-'));
  try {
    await writeFile(join(root, 'release-manifest.json'), '{}');
    await assert.rejects(runtimeLayout({ root, env: {} }), /发行清单无效/);
    await writeFile(join(root, 'release-manifest.json'), manifest);
    await assert.rejects(runtimeLayout({ root, env: {}, platform: 'win32' }), /无法确定/);
    const file = join(root, 'occupied'); await writeFile(file, 'keep');
    await assert.rejects(prepareRuntime({ root, env: { BOT_DATA_DIR: file } }), /无法初始化数据目录/);
    assert.equal(await readFile(file, 'utf8'), 'keep');
    assert.deepEqual((await readdir(root)).sort(), ['occupied', 'release-manifest.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('数据目录联接与程序目录联接归一，多个入口使用同一目录身份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-layout-alias-'));
  try {
    await mkdir(join(root, 'actual')); await symlink(join(root, 'actual'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const a = await runtimeLayout({ root: join(root, 'actual'), env: { BOT_DATA_DIR: join(root, 'actual/new') } });
    const b = await runtimeLayout({ root: join(root, 'alias'), env: { BOT_DATA_DIR: join(root, 'alias/new') } });
    assert.equal(a.programRoot, b.programRoot); assert.equal(a.dataRoot, b.dataRoot);
    assert.equal(await sameRuntimePath(join(root,'actual/new'),join(root,'alias/new')),true);
    assert.equal(await sameRuntimePath(join(root,'actual/new'),join(root,'actual/other')),false);
    await rm(join(root, 'alias'), { recursive: process.platform === 'win32' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('命令行从任意工作目录启动发行入口，按选定数据目录加载环境后才导入业务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-entry-'));
  try {
    const app = join(root, 'app with spaces'), data = join(root, '用户 data');
    await mkdir(join(app, 'scripts'), { recursive: true }); await mkdir(join(app, 'dist'));
    await mkdir(join(app, 'templates')); await mkdir(data);
    for (const file of ['app-paths.mjs','setup.mjs','run.mjs','credentials.mjs','env-file.mjs','process-guard.mjs','managed-entry.mjs']) await cp(resolve('scripts', file), join(app, 'scripts', file));
    await mkdir(join(app,'desktop'));await cp(resolve('desktop/ProcessGuard.cs'),join(app,'desktop/ProcessGuard.cs'));
    await writeFile(join(app, 'package.json'), '{"type":"module"}');
    await writeFile(join(app, 'release-manifest.json'), manifest);
    await writeFile(join(app, '.env.example'), 'BOT_CHAT_MODE=profile\n');
    await writeFile(join(app, 'templates/bot-persona.md'), 'default');
    await writeFile(join(data, '.env'), 'FIXTURE_VALUE=selected-data\n');
    await writeFile(join(app, 'dist/bridge.js'), 'console.log(JSON.stringify({cwd:process.cwd(),value:process.env.FIXTURE_VALUE,data:process.env.BOT_DATA_DIR}))');
    const result = await run(join(app, 'scripts/run.mjs'), ['bridge','--data-dir', data], { cwd: tmpdir(), env: { ...process.env, BOT_DATA_DIR: '' } });
    assert.equal(result.code, 0, result.errors); const output = JSON.parse(result.output);
    assert.equal(output.cwd, await realpath(data)); assert.equal(output.data, output.cwd); assert.equal(output.value, 'selected-data');
    assert.equal(await readFile(join(data, 'bot-workspace/AGENTS.md'), 'utf8'), 'default');
    assert.ok(!(await readdir(app)).includes('.env'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('桌面发行后台的读取、保存、子进程与日志统一使用数据目录，程序目录不写入个人文件', { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-host-layout-')));
  let child;
  try {
    const app = join(root, 'app'), data = join(root, '数据目录');
    await mkdir(app);
    for (const dir of ['desktop','dist','scripts','templates']) await cp(resolve(dir), join(app, dir), { recursive: true });
    await cp(resolve('.env.example'), join(app, '.env.example'));
    await writeFile(join(app, 'package.json'), '{"type":"module"}'); await writeFile(join(app, 'release-manifest.json'), manifest);
    await symlink(resolve('node_modules'), join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(app, 'desktop/diagnostics.mjs'), "import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {parseEnv} from 'node:util';export async function diagnose(){return {ok:true,rows:[]}};export async function environment(root){return {...process.env,...parseEnv(await readFile(join(root,'.env'),'utf8'))}};export async function onebotOnline(){return false}");
    await writeFile(join(app, 'dist/bridge.js'), "console.log('fixture-bridge '+JSON.stringify({cwd:process.cwd(),value:process.env.BOT_DSH_BIN}));process.on('message',m=>{if(m==='shutdown')process.exit()})");
    child = spawn(process.execPath, [join(app,'desktop/host.mjs'),'--data-dir',data], { cwd: tmpdir(), env: { ...process.env, BOT_DATA_DIR: '', BOT_DSH_BIN: '', BOT_WORKSPACE: '', BOT_SETTINGS_FILE: '' }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    let errors = ''; child.stderr.on('data', b => errors += b);
    const events = []; createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));
    const send = (action, value) => child.stdin.write(JSON.stringify({action, data:value})+'\n');
    send('load'); await until(() => events.some(e => e.type === 'config'), () => errors + JSON.stringify(events));
    const config = events.find(e => e.type === 'config');
    assert.equal(config.personaPath, join(data, 'bot-workspace/AGENTS.md'));
    assert.equal(config.settingsPath, join(data, 'bot.config.json'));
    send('runtime', { BOT_DSH_BIN: 'fixture-saved.cmd', BOT_ONEBOT_MODE: 'external' });
    await until(() => events.some(e => e.type === 'saved'), () => errors + JSON.stringify(events));
    send('start'); await until(() => events.some(e => e.text?.includes('fixture-bridge ')), () => errors + JSON.stringify(events));
    const bridge = JSON.parse(events.find(e => e.text?.includes('fixture-bridge ')).text.split('fixture-bridge ')[1]);
    assert.equal(bridge.cwd, data); assert.equal(bridge.value, 'fixture-saved.cmd');
    assert.equal(events.find(e => e.type === 'state').paths.dataRoot, data);
    assert.match(await readFile(join(data, 'data/desktop/console.log'), 'utf8'), /fixture-bridge/);
    for (const name of ['.env','bot.config.json','bot-workspace','data','napcat']) assert.ok(!(await readdir(app)).includes(name), name);
    const exited = once(child,'exit'); send('quit'); assert.equal((await exited)[0], 0);
    await rm(join(app, 'node_modules'), { recursive: process.platform === 'win32' });
  } finally {
    if (child?.exitCode === null) { const exited = once(child,'exit'); child.kill(); await exited; }
    // 先断开依赖目录链接，避免测试清理触及共享依赖。
    await rm(join(root,'app/node_modules'), { force: true, recursive: process.platform === 'win32' });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
