import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

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
    const connection = { runtime: { BOT_DSH_PROFILE: 'chat-test', BOT_MEDIA_BASE_URL: 'https://api.example.com/v1/' }, media: { visionModel: ' vision-test ', transcriptionModel: 'transcribe-test', videoFrames: 4 } };
    response = await worker('connection', connection);
    assert.equal(response.ok, true);
    assert.equal(response.result.settings.social.visionModel, 'vision-test');
    assert.equal(response.result.settings.identity.name, '小鲸');
    assert.match(response.result.env, /# 中文配置/);
    const savedEnv = await readFile(join(root, '.env'), 'utf8');
    const savedSettings = await readFile(join(root, 'bot.config.json'), 'utf8');
    for (const invalid of [
      { ...connection, runtime: { BOT_DSH_PROFILE: 'bad profile' } },
      { ...connection, runtime: { BOT_MEDIA_BASE_URL: 'file:///wrong' } },
      { ...connection, runtime: { BOT_MEDIA_BASE_URL: 'not a url' } },
      { ...connection, runtime: { BOT_MEDIA_BASE_URL: '' } },
      { ...connection, runtime: { ADMIN_QQ: '9007199254740992' } },
      { ...connection, media: { videoFrames: 0 } },
      { ...connection, media: { speechModel: 'x'.repeat(129) } },
      { ...connection, media: { allowAll: true } },
    ]) {
      assert.equal((await worker('connection', invalid)).ok, false);
      assert.equal(await readFile(join(root, '.env'), 'utf8'), savedEnv);
      assert.equal(await readFile(join(root, 'bot.config.json'), 'utf8'), savedSettings);
    }
    await mkdir(join(root, 'bot.config.json.tmp'));
    assert.equal((await worker('connection', { ...connection, runtime: { BOT_DSH_PROFILE: 'should-rollback' } })).ok, false);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), savedEnv);
    assert.equal(await readFile(join(root, 'bot.config.json'), 'utf8'), savedSettings);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('桌面控制：重复启动、模型重连、完整重启、仅在配置保存成功后重启和退出清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-desktop-host-'));
  for (const dir of ['desktop', 'dist', 'scripts']) await mkdir(join(root, dir));
  await cp(resolve('desktop/host.mjs'), join(root, 'desktop/host.mjs'));
  await writeFile(join(root, 'desktop/diagnostics.mjs'), "export async function diagnose(){return {ok:true,rows:[]}}; export async function environment(){return {ONEBOT_TOKEN:'secret-test-token'}}; export async function onebotOnline(){return false};");
  await writeFile(join(root, 'dist/bridge.js'), "console.log('bridge-started'); console.log('token=secret-test-token'); process.on('message', m => { if (m === 'shutdown') { console.log('graceful-stop'); process.exit(); } }); setInterval(() => {}, 1000);");
  await writeFile(join(root, 'scripts/napcat-node.mjs'), "console.log('napcat-started'); setInterval(() => {}, 1000);");
  await writeFile(join(root, 'desktop/config-worker.mjs'), "process.once('message', ({data}) => process.send(data.invalid ? {ok:false,error:'invalid-config'} : {ok:true,result:{restartAction:data.modelOnly?'restartBridge':'restart'}}, () => process.disconnect()));");
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
    send('restart'); await wait(() => events.filter(e => e.type === 'log' && e.text.includes('bridge-started')).length === 4 && events.filter(e => e.type === 'log' && e.text.includes('napcat-started')).length === 3);
    assert.equal(events.filter(e => e.type === 'log' && e.text.includes('napcat-started')).length, 3);
    child.stdin.write(JSON.stringify({ action: 'connection', data: { invalid: true, restart: true } }) + '\n');
    await wait(() => events.some(e => e.type === 'error' && e.text === 'invalid-config'));
    assert.equal(events.filter(e => e.type === 'log' && e.text.includes('bridge-started')).length, 4);
    child.stdin.write(JSON.stringify({ action: 'connection', data: { restart: true } }) + '\n');
    await wait(() => events.filter(e => e.type === 'log' && e.text.includes('bridge-started')).length === 5 && events.filter(e => e.type === 'log' && e.text.includes('napcat-started')).length === 4);
    assert.equal(events.filter(e => e.type === 'log' && e.text.includes('napcat-started')).length, 4);
    assert.ok(events.some(e => e.type === 'saved' && e.section === 'connection' && e.restartRequested));
    child.stdin.write(JSON.stringify({ action: 'connection', data: { restart: true, modelOnly: true } }) + '\n');
    await wait(() => events.filter(e => e.type === 'log' && e.text.includes('bridge-started')).length === 6);
    assert.equal(events.filter(e => e.type === 'log' && e.text.includes('napcat-started')).length, 4);
    send('quit'); await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(events.at(-1).bridge, false); assert.equal(events.at(-1).napcat, false);
    assert.ok(!JSON.stringify(events).includes('secret-test-token'));
    assert.ok(!(await readFile(join(root, 'data/desktop/console.log'), 'utf8')).includes('secret-test-token'));
  } finally { child.stdin.end(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('桌面对话模型：测试未保存输入、独立 Key 往返、保存失败保留配置、仅改模型保留 QQ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-desktop-model-'));
  const worker = (action, data) => new Promise((done, reject) => {
    const child = fork(resolve('desktop/config-worker.mjs'), [], { cwd: root, silent: true, execArgv: [], env: { ...process.env, BOT_SETTINGS_FILE: join(root, 'settings.json'), BOT_WORKSPACE: root } });
    let reply; child.once('message', value => { reply = value; }); child.once('exit', () => done(reply)); child.once('error', reject); child.send({ action, data });
  });
  const http = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume the minimal test prompt */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { data: [{ id: 'test-flash' }] } : { content: [{ type: 'text', text: 'OK' }] }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  try {
    await writeFile(join(root, '.env'), '# local configuration\nBOT_DSH_PROFILE=acp\n');
    const original = await readFile(join(root, '.env'), 'utf8');
    const runtime = { BOT_CHAT_MODE: 'project', BOT_CHAT_MODEL: 'test-flash', QQ_BOT_DEEPSEEK_API_KEY: 'project-fixture-key', BOT_CHAT_BASE_URL: `http://127.0.0.1:${http.address().port}/anthropic` };
    const listed = await worker('model', { operation: 'list', runtime }); assert.equal(listed.ok, true); assert.deepEqual(listed.result.models, ['test-flash']);
    const tested = await worker('model', { operation: 'test', runtime }); assert.equal(tested.ok, true); assert.equal(tested.result.model, 'test-flash');
    assert.equal(await readFile(join(root, '.env'), 'utf8'), original);
    const saved = await worker('connection', { runtime, media: {} }); assert.equal(saved.ok, true); assert.equal(saved.result.restartAction, 'restartBridge');
    const before = await readFile(join(root, '.env'), 'utf8');
    assert.match(before, /QQ_BOT_DEEPSEEK_API_KEY='project-fixture-key'/);
    const loaded = await worker('load');
    assert.equal(loaded.result.runtimeFields.find(f => f.key === 'QQ_BOT_DEEPSEEK_API_KEY').kind, 'secret');
    const invalid = await worker('connection', { runtime: { ...runtime, QQ_BOT_DEEPSEEK_API_KEY: '' }, media: {} }); assert.equal(invalid.ok, false);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), before);
    const changed = await worker('connection', { runtime: { ...runtime, ONEBOT_HTTP_URL: 'http://127.0.0.1:9999' }, media: {} }); assert.equal(changed.result.restartAction, 'restart');
    const account = await worker('connection', { runtime: { BOT_CHAT_MODE: 'account' }, media: {} }); assert.equal(account.ok, true);
    const profile = await worker('connection', { runtime: { BOT_CHAT_MODE: 'profile' }, media: {} }); assert.equal(profile.ok, true);
  } finally { http.closeAllConnections(); await new Promise(done => http.close(done)); await rm(root, { recursive: true, force: true }); }
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

test('桌面空间检查复用当前输入的 QQ 连接，不保存草稿、不发评论或泄露凭据',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-desktop-space-')),calls=[];
  const http=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,token:req.headers.authorization,args:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data:req.url==='/get_login_info'?{user_id:10000}:{cookies:'uin=o10000; p_uin=o10000; p_skey=fixture-private-space-cookie'}}));});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const worker=data=>new Promise((done,reject)=>{
    const child=fork(resolve('desktop/config-worker.mjs'),[],{cwd:root,env:{...process.env,BOT_SETTINGS_FILE:join(root,'settings.json'),BOT_WORKSPACE:root},execArgv:['--import',pathToFileURL(resolve('tests/fixtures/qzone-fetch.mjs')).href],silent:true});
    let reply;child.once('message',value=>{reply=value;});child.once('exit',()=>reply?done(reply):reject(new Error('空间检查未返回结果')));child.once('error',reject);child.send({action:'qzone-check',data});
  });
  try {
    const original='# original connection\nONEBOT_HTTP_URL=http://127.0.0.1:1\nONEBOT_TOKEN=old-fixture-token\nBOT_QZONE_ADAPTER_URL=https://unused.example/\n';await writeFile(join(root,'.env'),original);
    const checked=await worker({runtime:{ONEBOT_HTTP_URL:`http://127.0.0.1:${http.address().port}`,ONEBOT_TOKEN:'input-fixture-token'}});
    assert.equal(checked.ok,true);assert.equal(checked.result.account,10000);assert.match(checked.result.message,/空间连接正常/);
    assert.deepEqual(calls.map(call=>call.path),['/get_login_info','/get_cookies']);assert.equal(calls[1].args.domain,'user.qzone.qq.com');assert.ok(calls.every(call=>call.token==='Bearer input-fixture-token'));
    assert.doesNotMatch(JSON.stringify(checked),/fixture-private-space-cookie|input-fixture-token/);assert.equal(await readFile(join(root,'.env'),'utf8'),original);
    assert.equal((await worker({runtime:{BOT_QZONE_ADAPTER_URL:'https://example.test/'}})).ok,false);
  }finally{http.closeAllConnections();await new Promise(done=>http.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
