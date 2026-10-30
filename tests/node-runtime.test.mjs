import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertApplicationRuntime} from '../dist/core/node-runtime.js';
import {spawnSync} from 'node:child_process';
import {mkdtemp,realpath,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('数据库运行环境拒绝不支持的旧版及 Node 23，接受已验证的最低版本',()=>{
  for(const version of ['20.19.0','22.13.0','22.19.0','23.11.0','invalid','24.0.0-pre'])assert.throws(()=>assertApplicationRuntime(version),error=>error.code==='BOT_NODE_UNSUPPORTED'&&/22\.20/.test(error.message));
  for(const version of ['22.20.0','22.23.4','24.0.0','24.22.1','26.0.0'])assert.doesNotThrow(()=>assertApplicationRuntime(version));
});

test('不支持的版本在资源锁和数据库 Worker 打开前拒绝，不创建数据文件',async()=>{
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'qq-runtime-version-'));
  try{
    const lock=pathToFileURL(resolve('dist/core/resource-lock.js')).href,client=pathToFileURL(resolve('dist/storage/database-client.js')).href;
    // 在隔离进程固定版本输入，验证两个真实入口都执行检查；不打开旧版原生数据库。
    const code=`Object.defineProperty(process.versions,'node',{value:'22.13.0'});const {acquireDataResources}=await import(${JSON.stringify(lock)});const {DatabaseClient}=await import(${JSON.stringify(client)});const db=new DatabaseClient(${JSON.stringify(join(root,'db.sqlite'))});const results=await Promise.allSettled([acquireDataResources([{path:${JSON.stringify(join(root,'lock/data'))},label:'fixture'}]),db.open()]);for(const r of results)if(r.status==='fulfilled')r.value?.release?.();await db.close();console.log(JSON.stringify(results.map(r=>r.status==='rejected'?r.reason.code:'unexpected-success')));`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),['BOT_NODE_UNSUPPORTED','BOT_NODE_UNSUPPORTED']);assert.deepEqual(await readdir(root),[]);
  }finally{const actual=await realpath(root);assert.equal(dirname(actual),base);assert.ok(basename(actual).startsWith('qq-runtime-version-'));await rm(actual,{recursive:true,force:true});}
});

test('桌面诊断与实际入口使用相同运行库要求，旧版与预发行版不能通过检查',async()=>{
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'qq-runtime-diagnostics-'));
  try{
    const diagnostics=pathToFileURL(resolve('desktop/diagnostics.mjs')).href;
    const code=`import {diagnose} from ${JSON.stringify(diagnostics)};const rows=[];for(const version of ['22.13.0','22.19.0','23.11.0','24.0.0-pre','22.20.0','24.0.0']){Object.defineProperty(process.versions,'node',{value:version,configurable:true});const result=await diagnose(${JSON.stringify(root)},{env:{BOT_CHAT_MODE:'profile',BOT_ONEBOT_MODE:'external',BOT_DSH_HOME:${JSON.stringify(join(root,'dsh'))}}});const row=result.rows.find(row=>row.name==='Node.js 运行环境');rows.push({version,ok:row.ok,detail:row.detail});}console.log(JSON.stringify(rows));`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,0,result.stderr);
    const rows=JSON.parse(result.stdout);
    assert.deepEqual(rows.map(row=>row.ok),[false,false,false,false,true,true]);
    for(const row of rows)assert.match(row.detail,/22\.20/);
    assert.deepEqual(await readdir(root),[]);
  }finally{const actual=await realpath(root);assert.equal(dirname(actual),base);assert.ok(basename(actual).startsWith('qq-runtime-diagnostics-'));await rm(actual,{recursive:true,force:true});}
});
