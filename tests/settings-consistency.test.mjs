import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { SocialStore } from '../dist/social-store.js';
import { DailyUsageStore } from '../dist/usage.js';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'qq-settings-consistency-'));
  const worker = (action, data) => new Promise((done, reject) => {
    const env = { ...process.env };
    for (const key of ['BOT_SETTINGS_FILE','BOT_WORKSPACE','BOT_MEDIA_BASE_URL','BOT_CHAT_MODE','SESSION_STORE','BOT_SOCIAL_STORE','BOT_USAGE_STORE','BOT_GROUP_CONTEXT_STORE','BOT_MEDIA_DIR']) delete env[key];
    const child = fork(resolve('desktop/config-worker.mjs'), [], {cwd:root,env,execArgv:[],silent:true});
    let response;child.once('message', value=>{response=value;});child.once('exit',()=>response?done(response):reject(new Error('worker exited without response')));child.once('error',reject);child.send({action,data});
  });
  const a = structuredClone(DEFAULT_SETTINGS), b = structuredClone(DEFAULT_SETTINGS);
  a.identity.name='配置 A';b.identity.name='配置 B';
  await writeFile(join(root,'.env'),'BOT_SETTINGS_FILE=a.json\nBOT_WORKSPACE=.\nBOT_CHAT_MODE=profile\n');
  await writeFile(join(root,'a.json'),JSON.stringify(a));await writeFile(join(root,'b.json'),JSON.stringify(b));
  try {await run({root,worker,a,b});}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('切换动态配置文件时仅保存明确修改的媒体项，重载目标配置并保留原文件',()=>fixture(async({root,worker,a})=>{
  const before=await readFile(join(root,'a.json'),'utf8');
  let result=await worker('connection',{runtime:{BOT_SETTINGS_FILE:'b.json',BOT_MEDIA_BASE_URL:'https://example.test/v1/'},media:{visionModel:'new-vision',speechVoice:'old-voice'},mediaPaths:['visionModel']});
  assert.equal(result.ok,true);assert.equal(result.result.settingsSwitched,true);assert.equal(result.result.settings.identity.name,'配置 B');
  assert.equal(result.result.settings.social.visionModel,'new-vision');assert.equal(result.result.settings.social.speechVoice,'alloy');
  assert.equal(await readFile(join(root,'a.json'),'utf8'),before);
  result=await worker('load');assert.equal(result.result.settings.social.visionModel,'new-vision');assert.equal(result.result.settings.identity.name,'配置 B');
  const stale=structuredClone(a);stale.identity.name='旧窗口输入';
  assert.equal((await worker('settings',{draft:stale,baseline:a,paths:['identity.name'],settingsPath:join(root,'a.json')})).ok,false);
  assert.equal(JSON.parse(await readFile(join(root,'b.json'),'utf8')).identity.name,'配置 B');
}));

test('切换目标配置损坏时保留连接文件和原设置；高级文本切换同样加载目标',()=>fixture(async({root,worker})=>{
  const env=await readFile(join(root,'.env'),'utf8'),before=await readFile(join(root,'a.json'),'utf8');
  await writeFile(join(root,'broken.json'),'{broken');
  assert.equal((await worker('connection',{runtime:{BOT_SETTINGS_FILE:'broken.json'},media:{}})).ok,false);
  assert.equal(await readFile(join(root,'.env'),'utf8'),env);assert.equal(await readFile(join(root,'a.json'),'utf8'),before);
  const text='BOT_SETTINGS_FILE=b.json\nBOT_WORKSPACE=.\nBOT_CHAT_MODE=profile\n';
  assert.equal((await worker('env',{text,hasSettingsDrafts:true,settingsPath:join(root,'a.json')})).ok,false);
  const switched=await worker('env',{text,hasSettingsDrafts:false,settingsPath:join(root,'a.json')});
  assert.equal(switched.ok,true);assert.equal(switched.result.settings.identity.name,'配置 B');
}));

test('两个设置入口对缺失媒体服务的校验一致，失败不覆盖文件',()=>fixture(async({root,worker,a})=>{
  const before=await readFile(join(root,'a.json'),'utf8');a.social.visionModel='needs-service';
  const direct=await worker('settings',a),connection=await worker('connection',{runtime:{},media:{visionModel:'needs-service'}});
  assert.equal(direct.ok,false);assert.equal(connection.ok,false);assert.match(direct.error,/媒体服务地址/);assert.match(connection.error,/媒体服务地址/);
  assert.equal(await readFile(join(root,'a.json'),'utf8'),before);
  a.social.visionModel='   ';assert.equal((await worker('settings',a)).ok,true);assert.equal((await worker('load')).result.settings.social.visionModel,'');
  a.social.mediaEnabled=false;assert.equal((await worker('settings',a)).ok,true);
}));

test('连接入口保存媒体时保留同字段的外部编辑，并拒绝旧窗口回切配置文件',()=>fixture(async({root,worker,a})=>{
  const remote=structuredClone(a);remote.social.speechVoice='remote-voice';await writeFile(join(root,'a.json'),JSON.stringify(remote));
  const env=await readFile(join(root,'.env'),'utf8');
  const conflict=await worker('connection',{runtime:{},media:{speechVoice:'draft-voice'},mediaPaths:['speechVoice'],baseline:a,sourceSettingsPath:join(root,'a.json')});
  assert.equal(conflict.ok,false);assert.match(conflict.error,/已被其他操作修改/);assert.equal(await readFile(join(root,'.env'),'utf8'),env);
  await worker('env','BOT_SETTINGS_FILE=b.json\nBOT_WORKSPACE=.\nBOT_CHAT_MODE=profile\n');
  const stale=await worker('connection',{runtime:{BOT_SETTINGS_FILE:'a.json'},media:{},sourceSettingsPath:join(root,'a.json')});
  assert.equal(stale.ok,false);assert.equal((await worker('load')).result.settings.identity.name,'配置 B');
}));

test('保存草稿合并名单并保留外部其他设置，同字段冲突拒绝覆盖',()=>fixture(async({root,worker,a})=>{
  const baseline=structuredClone(a),draft=structuredClone(a);draft.social.blockedUsers=['10001'];draft.identity.name='新名称';
  const remote=structuredClone(a);remote.social.blockedUsers=['20002'];remote.chat.group.prefix='external';
  await writeFile(join(root,'a.json'),JSON.stringify(remote));
  const saved=await worker('settings',{draft,baseline,paths:['social.blockedUsers','identity.name'],settingsPath:join(root,'a.json')});
  assert.equal(saved.ok,true);assert.deepEqual(saved.result.social.blockedUsers,['20002','10001']);assert.equal(saved.result.chat.group.prefix,'external');
  const before=await readFile(join(root,'a.json'),'utf8');draft.identity.name='另一个旧编辑';
  assert.equal((await worker('settings',{draft,baseline,paths:['identity.name']})).ok,false);
  assert.equal(await readFile(join(root,'a.json'),'utf8'),before);
}));

test('管理页面显示真实额度余量、允许名单状态及群聊和私聊的实际配置来源',()=>fixture(async({root,worker,a})=>{
  a.social.allowAll=false;a.social.allowedUsers=['10001'];a.chat.privateAutoReply=false;
  await writeFile(join(root,'a.json'),JSON.stringify(a));
  const store=new SocialStore(join(root,'data/social.json'));await store.load();
  await store.update(d=>{d.contacts=[{chat:'group:30001',name:'测试群',at:1},{chat:'private:10001',name:'测试好友',at:1}];d.profiles=[{chat:'group:30001',persona:'',responseMode:'keywords',probability:10,keywords:['天气'],proactive:true},{chat:'private:10001',persona:'',responseMode:'all',probability:10,keywords:[],proactive:true}];});
  const usage=new DailyUsageStore(join(root,'data/daily-usage.json'));await usage.load();await usage.consume(()=>[{key:'reminders',amount:2,limit:5,label:'定时提醒'}]);
  const result=await worker('social',{op:'list',section:'contacts'});assert.equal(result.ok,true);
  const group=result.result.rows.find(r=>r.chat==='group:30001'),friend=result.result.rows.find(r=>r.chat==='private:10001');
  assert.equal(group.status,'未在允许名单');assert.match(group.summary,/会话专属/);assert.match(friend.summary,/自动回复已关闭/);
  const reminders=result.result.quotas.rows.find(r=>r.key==='reminders');assert.equal(reminders.used,2);assert.equal(reminders.remaining,3);assert.equal(result.result.quotas.live,false);
}));
