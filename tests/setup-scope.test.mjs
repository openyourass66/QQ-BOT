import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { allowedChat } from '../dist/qq/social-settings.js';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'qq-setup-scope-'));
  const path = join(root, 'settings.json'), calls = [];
  const state = { account: 10000, authorized: true, friends: [{user_id:10001,nickname:'主人'}, {user_id:10002,remark:'好友备注'}], groups: [{group_id:30001,group_name:'测试群'}] };
  const server = createServer(async (request, response) => {
    calls.push({ path: request.url, authorization: request.headers.authorization });
    if (state.beforeReply) await state.beforeReply(request.url);
    const data = request.url === '/get_login_info' ? {user_id:state.account} : request.url === '/get_friend_list' ? state.friends : state.groups;
    response.setHeader('content-type','application/json');
    response.statusCode = state.authorized ? 200 : 401;
    response.end(JSON.stringify({status:state.authorized?'ok':'failed',retcode:state.authorized?0:401,data}));
  });
  server.listen(0, '127.0.0.1'); await once(server,'listening');
  await writeFile(join(root,'.env'), `BOT_SETTINGS_FILE=settings.json\nBOT_WORKSPACE=.\nBOT_DSH_BIN=custom.cmd\nBOT_ONEBOT_MODE=external\nONEBOT_HTTP_URL=http://127.0.0.1:${server.address().port}\nONEBOT_TOKEN=fixture-scope-secret\n`);
  const worker = (action, data) => new Promise((done, reject) => {
    const child = fork(resolve('desktop/config-worker.mjs'),[],{cwd:root,silent:true,execArgv:[],env:{...process.env,BOT_DATA_DIR:'',BOT_SETTINGS_FILE:path,BOT_WORKSPACE:root,ALLOW_EXEC:'1'}});
    let reply;child.once('message',value=>{reply=value;});child.once('exit',()=>reply?done(reply):reject(new Error('配置进程未返回结果')));child.once('error',reject);child.send({action,data});
  });
  const load = () => worker('load');
  const contacts = async () => {
    const result = await worker('onboarding',{operation:'contacts',runtime:{},requestId:'fixture-request'});
    assert.equal(result.ok,true,JSON.stringify(result));return result.result;
  };
  const scope = result => ({account:result.account,owner:'10001',users:[],groups:['30001'],baseline:result.baseline});
  const save = draft => worker('connection',{runtime:{},media:{},scope:draft,sourceSettingsPath:path});
  try { await run({root,path,state,calls,worker,load,contacts,scope,save}); }
  finally { server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50}); }
}

test('新实例只启用有限范围基础聊天，未选择范围时不标记完成或允许向导启动',()=>fixture(async({root,path,worker,load})=>{
  const result=await load();assert.equal(result.ok,true);assert.equal(result.result.needsSetup,true);
  const settings=result.result.settings;
  assert.deepEqual(settings.installation,{version:1,scopeConfigured:false});
  assert.equal(settings.social.allowAll,false);assert.equal(settings.social.autonomy,'sensitive');assert.equal(settings.approval.allowExec,false);
  for(const key of ['proactiveEnabled','autonomousEnabled','autoCollectStickers','autoQzoneEnabled','autoQzoneCommentEnabled'])assert.equal(settings.social[key],false,key);
  assert.equal(settings.features.qzone.enabled,false);assert.equal(settings.learning.memory,false);
  assert.equal(allowedChat(settings.social,'private:10001'),false);
  const before=await readFile(path,'utf8'),env=await readFile(join(root,'.env'),'utf8');
  const refused=await worker('connection',{runtime:{},media:{},restart:true});assert.equal(refused.ok,false);assert.match(refused.error,/选择主人和联系范围/);
  assert.equal(await readFile(path,'utf8'),before);assert.equal(await readFile(join(root,'.env'),'utf8'),env);
}));

test('实际联系人选择与连接一同保存，主人加入允许私聊，其他设置与个人内容保留',()=>fixture(async({root,path,calls,load,contacts,scope,save})=>{
  await load();const result=await contacts();assert.equal(result.requestId,'fixture-request');assert.equal(result.friends[1].name,'好友备注');
  const changed=JSON.parse(await readFile(path,'utf8'));changed.identity.name='个人名称';changed.social.quietStartHour=22;await writeFile(path,JSON.stringify(changed));
  const saved=await save(scope(result));assert.equal(saved.ok,true,JSON.stringify(saved));
  const settings=saved.result.settings;
  assert.deepEqual(settings.installation,{version:1,scopeConfigured:true});assert.equal(settings.approval.adminQq,10001);
  assert.deepEqual(settings.social.allowedUsers,['10001']);assert.deepEqual(settings.social.allowedGroups,['30001']);assert.equal(settings.social.allowAll,false);
  assert.equal(settings.identity.name,'个人名称');assert.equal(settings.social.quietStartHour,22);assert.equal(settings.social.autonomousEnabled,false);
  assert.equal((await load()).result.needsSetup,false);
  assert.equal(allowedChat(settings.social,'private:10001'),true);assert.equal(allowedChat(settings.social,'group:30001'),true);assert.equal(allowedChat(settings.social,'private:10002'),false);
  assert.ok(calls.every(call=>['/get_login_info','/get_friend_list','/get_group_list'].includes(call.path)));
  assert.ok(calls.every(call=>call.authorization==='Bearer fixture-scope-secret'));
  assert.doesNotMatch(JSON.stringify(result),/fixture-scope-secret/);
}));

test('允许暂不设置主人并仅开放所选群，不暗中放开其它会话',()=>fixture(async({load,contacts,scope,save})=>{
  await load();const draft=scope(await contacts());draft.owner='0';const saved=await save(draft);assert.equal(saved.ok,true,JSON.stringify(saved));
  assert.equal(saved.result.settings.approval.adminQq,0);assert.deepEqual(saved.result.settings.social.allowedUsers,[]);assert.equal(saved.result.settings.social.allowAll,false);
}));

test('读取失败、机器人换号、联系人被移除、屏蔽与过期范围均保留原文件',()=>fixture(async({root,path,state,load,contacts,scope,save,worker})=>{
  await load();const listed=await contacts(),draft=scope(listed);
  const original=await readFile(path,'utf8'),env=await readFile(join(root,'.env'),'utf8');
  state.authorized=false;const failure=await worker('onboarding',{operation:'contacts',runtime:{}});assert.equal(failure.ok,false);assert.doesNotMatch(failure.error,/fixture-scope-secret/);
  assert.equal((await save(draft)).ok,false);state.authorized=true;
  state.account=20000;assert.equal((await save(draft)).ok,false);state.account=10000;
  state.groups=[];assert.equal((await save(draft)).ok,false);state.groups=[{group_id:30001,group_name:'测试群'}];
  assert.equal(await readFile(path,'utf8'),original);assert.equal(await readFile(join(root,'.env'),'utf8'),env);
  const changed=JSON.parse(original);changed.social.blockedUsers=['10001'];await writeFile(path,JSON.stringify(changed));
  const blocked=await save(draft);assert.equal(blocked.ok,false);assert.match(blocked.error,/未屏蔽/);
  changed.social.blockedUsers=[];changed.approval.adminQq=10002;await writeFile(path,JSON.stringify(changed));
  const stale=await save(draft);assert.equal(stale.ok,false);assert.match(stale.error,/其他操作修改/);
  assert.equal(JSON.parse(await readFile(path,'utf8')).approval.adminQq,10002);
}));

test('范围保存期间重新读取文件，拒绝覆盖新主人并保留无关设置更新',()=>fixture(async({path,state,load,contacts,scope,save})=>{
  await load();const draft=scope(await contacts());
  state.beforeReply=async endpoint=>{if(endpoint==='/get_login_info'){const latest=JSON.parse(await readFile(path,'utf8'));latest.approval.adminQq=10002;await writeFile(path,JSON.stringify(latest));}};
  const saved=await save(draft);assert.equal(saved.ok,false);assert.match(saved.error,/其他操作修改/);assert.equal(JSON.parse(await readFile(path,'utf8')).approval.adminQq,10002);
  state.beforeReply=null;const fresh=scope(await contacts());
  state.beforeReply=async endpoint=>{if(endpoint==='/get_login_info'){const latest=JSON.parse(await readFile(path,'utf8'));latest.identity.name='读取期间更新';await writeFile(path,JSON.stringify(latest));}};
  const result=await save(fresh);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.settings.identity.name,'读取期间更新');
}));

test('已有未版本化配置不自动重置开放范围或自主设置，损坏文件不覆盖',()=>fixture(async({path,load})=>{
  const old={social:{allowAll:true,autonomousEnabled:true,autoQzoneEnabled:true},approval:{adminQq:10001,allowExec:true},identity:{name:'旧名称'}};
  await writeFile(path,JSON.stringify(old));const before=await readFile(path,'utf8');const result=await load();
  assert.equal(result.ok,true);assert.equal(result.result.needsSetup,false);assert.equal(result.result.settings.installation,undefined);
  assert.equal(result.result.settings.social.allowAll,true);assert.equal(result.result.settings.social.autonomousEnabled,true);assert.equal(result.result.settings.approval.allowExec,true);
  assert.equal(await readFile(path,'utf8'),before);
  await writeFile(path,'{broken');assert.equal((await load()).ok,false);assert.equal(await readFile(path,'utf8'),'{broken');
}));
