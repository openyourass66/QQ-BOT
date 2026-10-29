import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeToolDenial,apply} from '../dist/security/dsh-policy.js';
import {socialTools} from '../dist/qq/social-tools.js';
import {legacyTools} from '../dist/qq/legacy-tools.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('原生守卫只允许真实 QQ 工具与联网，伪装标题、任意文件、Shell、子代理及嵌套执行均拒绝',()=>{
  for(const tool of [...socialTools,...legacyTools])assert.equal(nativeToolDenial({name:`mcp__qq__${tool.name}`}),undefined);
  assert.equal(nativeToolDenial({name:'web_search',arguments:{queries:['普通搜索']}}),undefined);
  assert.equal(nativeToolDenial({name:'web_fetch',arguments:{url:'https://example.com/article'}}),undefined);
  for(const name of ['read_file','read','search_files','bash','powershell','exec_command','run_code','spawn_agent','mcp__other__qq_reply','mcp__qq__unknown'])assert.ok(nativeToolDenial({name,arguments:{kind:'read',confirmed:true}}),name);
  for(const url of ['file:///C:/private.env','http://localhost/config','http://127.0.0.1/','http://10.0.0.1/','http://192.168.1.1/','http://172.16.0.1/','http://[::1]/','https://user:password@example.com/'])assert.ok(nativeToolDenial({name:'web_fetch',arguments:{url}}),url);
});

test('不支持单调守卫的运行组件拒绝启动，守卫绑定真实分派而非模型参数声明',()=>{
  assert.throws(()=>apply({tools:{}}),/不支持必需的工具边界/);
  let guard;apply({tools:{guard(value){guard=value;}}});
  assert.equal(guard,nativeToolDenial);assert.ok(guard({name:'read_file',arguments:{path:'.env'}}));
});

for(const omitted of ['NATIVE','BUDGET','SESSION'])test(`ACP 虽然可连接但缺少 ${omitted} 边界时，桥接拒绝开放模型和 QQ 业务`,{timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-no-native-policy-')),wrapper=join(root,process.platform==='win32'?'fake.cmd':'fake-dsh');
  const fake=resolve('tests/fixtures/fake-dsh.mjs');let child,output='';
  try{
    await writeFile(wrapper,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o700});
    child=spawn(process.execPath,[resolve('dist/bridge.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BOT_DSH_BIN:wrapper,BOT_CHAT_MODE:'profile',BOT_WORKSPACE:root,BOT_SETTINGS_FILE:join(root,'settings.json'),SESSION_STORE:join(root,'sessions.json'),BOT_SOCIAL_STORE:join(root,'social.json'),BOT_GROUP_CONTEXT_STORE:join(root,'context.json'),BOT_USAGE_STORE:join(root,'usage.json'),BOT_MEDIA_DIR:join(root,'media'),['FAKE_OMIT_'+omitted+'_POLICY']:'1'}});
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    assert.equal((await once(child,'exit'))[0],1,output);assert.match(output,omitted==='SESSION'?/不支持确认释放会话/:/受限工具策略未加载/);assert.doesNotMatch(output,/\[bridge\] ready/);
  }finally{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
