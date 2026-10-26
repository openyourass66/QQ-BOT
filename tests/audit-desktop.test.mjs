import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { diagnose } from '../desktop/diagnostics.mjs';

test('诊断复用外部 OneBot 时不强制要求本机 QQ/NapCat 安装',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-external-audit-'));
  try {
    await mkdir(join(root,'dist'));await writeFile(join(root,'dist/bridge.js'),'');await writeFile(join(root,'fake-dsh.cmd'),'');
    await writeFile(join(root,'.env'),`BOT_CHAT_MODE=profile\nBOT_DSH_BIN=fake-dsh.cmd\nBOT_DSH_HOME='${root.replaceAll('\\','/')}/dsh'\nBOT_WORKSPACE=.\nBOT_NAPCAT_DIR=missing\nBOT_QQ_DIR=missing\nONEBOT_HTTP_URL=http://127.0.0.1:1\nONEBOT_WS_URL=ws://127.0.0.1:1\n`);
    assert.equal((await diagnose(root)).ok,false);
    const checked=await diagnose(root,{externalOnebot:true});assert.equal(checked.ok,true,JSON.stringify(checked));
    for(const name of ['NapCat Shell','NapCat Node 适配库','QQ 安装目录'])assert.equal(checked.rows.find(row=>row.name===name).required,false);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('保存并重启检查失败时报告失败，保留原进程；恢复检查后才报告完成', {timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-restart-audit-'));
  for(const name of ['desktop','dist','scripts'])await mkdir(join(root,name));
  await cp(resolve('desktop/host.mjs'),join(root,'desktop/host.mjs'));
  for (const file of ['app-paths.mjs','setup.mjs']) await cp(resolve('scripts',file),join(root,'scripts',file));
  await writeFile(join(root,'desktop/diagnostics.mjs'),`import {existsSync} from 'node:fs';export async function diagnose(root){return {ok:!existsSync(root+'/fail'),rows:[]}};export async function environment(){return {}};export async function onebotOnline(){return true};`);
  await writeFile(join(root,'desktop/config-worker.mjs'),`process.once('message',()=>process.send({ok:true,result:{restartAction:'restartBridge'}},()=>process.disconnect()));`);
  await writeFile(join(root,'dist/bridge.js'),`console.log('audit-bridge-started');process.on('message',m=>{if(m==='shutdown')process.exit()});setInterval(()=>{},1000);`);
  const child=spawn(process.execPath,[join(root,'desktop/host.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const events=[];createInterface({input:child.stdout}).on('line',line=>events.push(JSON.parse(line)));
  const until=async(predicate)=>{const limit=Date.now()+7000;while(!predicate()){if(Date.now()>limit)throw new Error('重启审计等待超时：'+JSON.stringify(events));await new Promise(r=>setTimeout(r,15));}};
  const send=(action,data)=>child.stdin.write(JSON.stringify({action,data})+'\n');
  const starts=()=>events.filter(e=>e.type==='log'&&e.text.includes('audit-bridge-started')).length;
  try {
    send('start');await until(()=>starts()===1);await writeFile(join(root,'fail'),'1');
    send('connection',{restart:true});await until(()=>events.some(e=>e.type==='control'&&e.action==='restartBridge'&&e.ok===false));
    assert.equal(starts(),1);assert.ok(events.some(e=>e.type==='saved'&&e.restartRequested));
    assert.equal(events.at(-1).bridge,true);assert.equal(events.at(-1).busy,false);
    await rm(join(root,'fail'));const before=events.length;send('restartBridge');await until(()=>starts()===2);
    assert.ok(events.slice(before).some(e=>e.type==='control'&&e.action==='restartBridge'&&e.ok));
    send('quit');const [code]=await once(child,'exit');assert.equal(code,0);
  } finally {
    if(child.exitCode===null){child.stdin.end();await once(child,'exit');}
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
