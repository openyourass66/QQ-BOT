import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,utimes,symlink,lstat} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {exportDiagnostics} from '../scripts/diagnostic-export.mjs';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';

const privateText='fixture-private-body-token-qq-987654321';
async function fixture(run){
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'qq-maintenance-tools-')),dataRoot=join(root,'中文 数据'),file=join(root,'share.wwdiagnostic.json');
  try{await mkdir(dataRoot);await writeFile(join(dataRoot,'.env'),'ONEBOT_TOKEN='+privateText+'\nBOT_CHAT_MODE=project\nBOT_WORKSPACE='+privateText+'\n');await writeFile(join(dataRoot,'bot.config.json'),JSON.stringify({name:privateText}));await mkdir(join(dataRoot,'data/desktop'),{recursive:true});await writeFile(join(dataRoot,'data/desktop/console.log'),privateText);await run({root,dataRoot,file,options:{root:resolve('.'),dataRoot,file}});}
  finally{const actual=await realpath(root);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('qq-maintenance-tools-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}
async function worker(dataRoot,data){
  const child=fork(resolve('desktop/maintenance-worker.mjs'),[],{cwd:dataRoot,windowsHide:true,silent:true,execArgv:[]});child.stdout.resume();child.stderr.resume();
  const response=new Promise((done,reject)=>{child.on('message',message=>{if(typeof message.ok==='boolean')done(message);});child.once('error',reject);child.once('exit',()=>reject(new Error('Worker exited without reply')));});
  const exited=once(child,'exit'),timer=setTimeout(()=>child.kill(),30000);child.send({data});try{const result=await response;await exited;return result;}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
test('可分享诊断只包含白名单字段，排除日志、配置正文、路径及聊天内容',()=>fixture(async({dataRoot,file,options})=>{
  const paths=dataPaths({},dataRoot),social=new SqliteSocialStore(paths.social),usage=new SqliteDailyUsageStore(paths.usage);try{await social.load();await usage.load();await social.update(data=>data.memories.push({id:'private',chat:'private:987654321',user:'987654321',name:privateText,text:privateText,at:1}));}finally{await social.close();await usage.close();}
  const result=await exportDiagnostics(options),raw=await readFile(file,'utf8'),record=JSON.parse(raw);assert.equal(result.operation,'diagnostic');assert.equal(record.kind,'whale-redacted-diagnostic');assert.equal(record.databases.social.integrity,'ok');assert.equal(record.configuration.credentials.ONEBOT_TOKEN,true);assert.ok(!raw.includes(privateText));assert.ok(!raw.includes('987654321'));assert.ok(!raw.includes(dataRoot.replaceAll('\\','\\\\')));assert.deepEqual(Object.keys(record.configuration).sort(),['chatMode','credentials','onebotMode','status']);
}));
test('诊断拒绝覆盖、实例内输出及链接，不影响坏数据库和恢复中断标记',()=>fixture(async({root,dataRoot,file,options})=>{
  await writeFile(file,'keep');await assert.rejects(exportDiagnostics(options),/目标已存在/);assert.equal(await readFile(file,'utf8'),'keep');await rm(file);await assert.rejects(exportDiagnostics({...options,file:join(dataRoot,'new.json')}),/目录之外/);
  await mkdir(join(root,'actual'));await symlink(join(root,'actual'),join(root,'alias'),process.platform==='win32'?'junction':'dir');await assert.rejects(exportDiagnostics({...options,file:join(root,'alias/diagnostic.json')}),/链接/);
  await writeFile(join(dataRoot,'data/social.json.sqlite'),privateText);await writeFile(join(dataRoot,'.restore-journal.json'),'{}');await exportDiagnostics(options);const record=JSON.parse(await readFile(file,'utf8'));assert.equal(record.recoveryPending,true);assert.equal(record.databases.social.integrity,'unavailable');assert.equal(await readFile(join(dataRoot,'data/social.json.sqlite'),'utf8'),privateText);
}));
test('诊断与运行实例互斥，取消不发布半成品且释放锁',()=>fixture(async({root,dataRoot,file,options})=>{
  const held=await acquireDataResources(mutableDataResources(dataPaths({},dataRoot)));try{await assert.rejects(exportDiagnostics(options),{code:'BOT_RESOURCE_LOCKED'});}finally{held.release();}
  const cancel=new AbortController();await assert.rejects(exportDiagnostics({...options,signal:cancel.signal,onProgress:()=>cancel.abort(new Error('cancel-fixture'))}),/cancel-fixture/);await assert.rejects(lstat(file),{code:'ENOENT'});const next=await acquireDataResources(mutableDataResources(dataPaths({},dataRoot)));next.release();
}));
test('实际维护 Worker 可导出诊断，不接受未知字段和无效清理参数',()=>fixture(async({dataRoot,file})=>{
  const result=await worker(dataRoot,{operation:'diagnostic',file});assert.equal(result.ok,true);assert.equal(JSON.parse(await readFile(file,'utf8')).kind,'whale-redacted-diagnostic');
  assert.equal((await worker(dataRoot,{operation:'cleanup',retentionDays:0})).ok,false);assert.equal((await worker(dataRoot,{operation:'cleanup',retentionDays:30,command:'delete-all'})).ok,false);
}));
test('媒体维护 Worker 先预览再按相同保留期删除，保留收藏和用户文件',()=>fixture(async({dataRoot})=>{
  if(process.platform!=='win32')return;
  const paths=dataPaths({},dataRoot),social=new SqliteSocialStore(paths.social),usage=new SqliteDailyUsageStore(paths.usage),name=body=>createHash('sha256').update(body).digest('hex')+'.png';await mkdir(paths.media,{recursive:true});
  const free=join(paths.media,name('free')),favorite=join(paths.media,name('favorite'));for(const [path,body] of [[free,'free'],[favorite,'favorite']]){await writeFile(path,body);const old=new Date(Date.now()-60*86400000);await utimes(path,old,old);}await writeFile(join(paths.media,'user.txt'),privateText);
  try{await social.load();await usage.load();await social.update(data=>data.stickers.push({id:'favorite',file:favorite,note:privateText,tags:[],uses:0,at:1,qqPresent:true}));}finally{await social.close();await usage.close();}
  const preview=await worker(dataRoot,{operation:'cleanup-preview',retentionDays:30});assert.equal(preview.ok,true);assert.equal(preview.result.eligible,1);assert.equal(preview.result.protected,1);assert.equal(await readFile(free,'utf8'),'free');
  const clean=await worker(dataRoot,{operation:'cleanup',retentionDays:30});assert.equal(clean.ok,true);assert.equal(clean.result.deleted,1);await assert.rejects(lstat(free),{code:'ENOENT'});assert.equal(await readFile(favorite,'utf8'),'favorite');assert.equal(await readFile(join(paths.media,'user.txt'),'utf8'),privateText);
}));
