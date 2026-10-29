import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,utimes,realpath,lstat,link,unlink,open,rename,symlink,cp} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {MemoryMediaCacheStore} from '../dist/storage/memory-media-cache.js';
import {MediaCache} from '../dist/services/media-cache.js';
import {MediaService} from '../dist/services/media.js';
import {cleanupMedia} from '../dist/services/media-cleanup.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {mediaCleanerExecutable,mediaRemover} from '../scripts/media-cleaner.mjs';

const old=Date.now()-60*86400000,cutoff=Date.now()-30*86400000;
const name=body=>createHash('sha256').update(body).digest('hex')+'.png';
async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'qq-media-cleanup-')),paths=dataPaths({},root),resources=[],keep=item=>{resources.push(item);return item;};
  const seed=async()=>{const social=keep(new SqliteSocialStore(paths.social)),usage=keep(new SqliteDailyUsageStore(paths.usage));await social.load();await usage.load();return {social,usage};};
  const file=async(body,at=old)=>{await mkdir(paths.media,{recursive:true});const path=join(paths.media,name(body));await writeFile(path,body);await utimes(path,new Date(at),new Date(at));return path;};
  const native=async()=>mediaRemover(await mediaCleanerExecutable({root:resolve('.'),dataRoot:root}));
  try{await run({root,paths,seed,file,native,keep});}
  finally{for(const item of resources)await item.close?.();const actual=await realpath(root),base=await realpath(tmpdir()),rel=relative(base,actual);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(actual).startsWith('qq-media-cleanup-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}
const r=(payload)=>({id:randomUUID(),turn:randomUUID(),account:1,chat:'private:2',user:'2',origin:'message',tool:'qq_send_file',payload,summary:'文件'});
const quotas=()=>[{key:'social-actions',amount:1,limit:100,label:'动作'}];
async function cli(root,...args){
  const env={...process.env};for(const key of Object.keys(env))if(/^(BOT_|ONEBOT_|QQ_BOT_|SESSION_STORE$|NODE_OPTIONS$)/.test(key))delete env[key];
  const child=spawn(process.execPath,[resolve('scripts/storage.mjs'),'cleanup-media','--data-dir',root,...args],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);const [code]=await once(child,'exit');return {code,output,errors};
}

for(const implementation of ['memory','sqlite'])test(`${implementation} 清理候选按访问时间与名称分页，排除近期/非受管/未完成文件`,()=>fixture(async({seed})=>{
  const {usage}=await seed(),store=implementation==='sqlite'?usage.mediaCacheStore:new MemoryMediaCacheStore();
  await store.call({action:'media-cache-scan-start',root:'fixture',owner:'scan'});
  const entries=Array.from({length:75},(_,i)=>({name:name('entry'+i),size:1,mtime:i,owned:i!==0}));entries.push({name:name('fresh-mtime'),size:1,mtime:500,owned:true});
  await store.call({action:'media-cache-scan-batch',owner:'scan',entries});await store.call({action:'media-cache-scan-complete',owner:'scan'});
  await store.call({action:'media-cache-touch',name:entries[1].name,at:500});await store.call({action:'media-cache-reserve',name:name('reserved'),size:1,limit:1000,owner:'writer'});
  const found=[];let after;
  for(;;){const rows=await store.call({action:'media-cache-candidates',cutoff:100,limit:9,after});if(!rows.length)break;found.push(...rows);const last=rows.at(-1);after={lastUsed:last.lastUsed,name:last.name};}
  assert.equal(found.length,73);assert.equal(new Set(found.map(row=>row.name)).size,73);assert.ok(found.every(row=>row.state==='complete'&&row.owned&&row.lastUsed<=100&&row.mtime<=100));
  for(const request of [{cutoff:Infinity,limit:1},{cutoff:1,limit:65},{cutoff:1,limit:1,after:{name:'../escape',lastUsed:1}}])await assert.rejects(store.call({action:'media-cache-candidates',...request}),{code:'DATABASE_MEDIA_INVALID'});
}));

test('预览同时保护收藏、提醒、未知动作与动态登记文件，保留近期、用户文件和临时文件',()=>fixture(async({root,paths,seed,file})=>{
  const {social,usage}=await seed(),free=await file('free'),favorite=await file('favorite'),task=await file('task'),unknown=await file('unknown'),pinned=await file('pinned');await file('recent',Date.now());
  await writeFile(join(paths.media,'用户资料.txt'),'private');await writeFile(join(paths.media,'unconfirmed.tmp'),'temporary');
  await social.update(d=>{d.stickers.push({id:'favorite',file:favorite,note:'收藏',tags:[],uses:0,at:1,qqPresent:true});d.tasks.push({id:'task',chat:'private:2',creator:'2',text:task,due:Date.now()+86400000,interval:0,state:'pending',error:'',retryAt:0});});
  const operation=r({source:unknown});await usage.beginOperation(operation);await usage.reserveOperation(operation.id,0,quotas);await usage.submitOperation(operation.id,0,'upload_private_file',{file:unknown});await usage.failOperation(operation.id,'响应未知');
  const pin=r({text:'动态生成'});await usage.beginOperation(pin);await usage.mediaReferenceStore.call({action:'media-refs-pin',name:basename(pinned),operationId:pin.id,owner:usage.instanceId});await social.close();await usage.close();
  const before=await readdir(paths.media),result=await cleanupMedia(paths,{dryRun:true});assert.equal(result.eligible,1);assert.equal(result.protected,4);assert.equal(result.deleted,0);assert.equal(result.complete,true);assert.deepEqual(await readdir(paths.media),before);assert.equal(await readFile(free,'utf8'),'free');
  const db=new DatabaseSync(paths.usage+'.sqlite',{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM external_operations WHERE id=?').get(operation.id).state,'unknown');assert.equal(db.prepare('SELECT state FROM external_operations WHERE id=?').get(pin.id).state,'created','离线清理不运行启动阶段动作恢复');}finally{db.close();}
}));

test('历史引用回填完成前不删除，旧 schema 8 的收藏和消息引用完整恢复',()=>fixture(async({paths,seed,file})=>{
  const {social,usage}=await seed(),saved=await file('historical');await social.add({chat:'private:2',id:1,user:2,name:'好友',at:Date.now(),text:'历史',segments:[{type:'image',data:{file:saved}}],self:false,recalled:false});await social.close();await usage.close();
  const db=new DatabaseSync(paths.social+'.sqlite');try{for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'media_refs_%'").all())db.exec(`DROP TRIGGER "${row.name}"`);db.exec("DROP TABLE media_references;DELETE FROM runtime_meta WHERE key LIKE 'media_refs_%';PRAGMA user_version=8;");}finally{db.close();}
  const result=await cleanupMedia(paths,{dryRun:true});assert.equal(result.protected,1);assert.equal(result.eligible,0);assert.equal(await readFile(saved,'utf8'),'historical');
}));

test('缺失数据库、源 JSON 已变化、无效参数和未确认保存均拒绝删除并保留文件',()=>fixture(async({root,paths,seed,file})=>{
  const saved=await file('preserve');let calls=0;const remove=async()=>{calls++;return {status:'deleted'};};
  await assert.rejects(cleanupMedia(paths,{remove}),/已经迁移/);assert.equal(calls,0);
  const {social,usage}=await seed();await social.close();
  const cache=new MediaCache(paths.media,usage.mediaCacheStore);await cache.statistics();await usage.mediaCacheStore.call({action:'media-cache-reserve',name:name('reserved'),size:3,limit:1000,owner:'writer'});await usage.close();
  await assert.rejects(cleanupMedia(paths,{remove}),/未确认记录/);assert.equal(calls,0);assert.equal(await readFile(saved,'utf8'),'preserve');
  for(const options of [{retentionDays:0},{limit:1001},{budgetMs:0}])await assert.rejects(cleanupMedia(paths,{remove,...options}),{code:'MEDIA_CLEANUP_INVALID'});
  const db=new DatabaseSync(paths.usage+'.sqlite');try{db.prepare("DELETE FROM media_cache_files WHERE state='stale'").run();}finally{db.close();}
  await writeFile(paths.social,'modified private source');await assert.rejects(cleanupMedia(paths,{remove}),/旧数据文件/);assert.equal(calls,0);assert.equal(await readFile(saved,'utf8'),'preserve');
}));

test('共用资源锁拒绝在线清理；清理在途和取消收尾期间继续阻止第二实例取得资源',()=>fixture(async({paths,seed,file})=>{
  const {social,usage}=await seed();await file('locked');await social.close();await usage.close();
  const held=await acquireDataResources(mutableDataResources(paths));try{await assert.rejects(cleanupMedia(paths,{dryRun:true}),{code:'BOT_RESOURCE_LOCKED'});}finally{held.release();}
  let entered,release;const ready=new Promise(done=>entered=done),gate=new Promise(done=>release=done),abort=new AbortController();
  const running=cleanupMedia(paths,{signal:abort.signal,remove:async()=>{entered();await gate;abort.signal.throwIfAborted();return {status:'kept'};}});const failed=assert.rejects(running,/cancelled/);await ready;abort.abort(new Error('cancelled'));
  try{await assert.rejects(acquireDataResources(mutableDataResources(paths)),{code:'BOT_RESOURCE_LOCKED'});}finally{release();}await failed;
  const released=await acquireDataResources(mutableDataResources(paths));released.release();
}));

test('单次候选上限及时间预算提前返回，已取消任务不开始删除，预览不输出私有正文',()=>fixture(async({root,paths,seed,file})=>{
  const {social,usage}=await seed();for(let i=0;i<4;i++)await file('limited-'+i);await social.close();await usage.close();
  const limited=await cleanupMedia(paths,{dryRun:true,limit:2});assert.equal(limited.eligible,2);assert.equal(limited.complete,false);assert.equal(limited.reason,'limit');
  const budget=await cleanupMedia(paths,{dryRun:true,budgetMs:1});assert.equal(budget.deleted,0);assert.equal(budget.reason,'time-budget');
  const aborted=new AbortController();aborted.abort(new Error('already cancelled'));await assert.rejects(cleanupMedia(paths,{dryRun:true,signal:aborted.signal}),/already cancelled/);
  await writeFile(join(root,'.env'),'ONEBOT_TOKEN=fixture-secret-token\n');const preview=await cli(root,'--dry-run');assert.equal(preview.code,0,preview.errors);assert.equal(JSON.parse(preview.output).eligible,4);assert.doesNotMatch(preview.output+preview.errors,/fixture-secret-token|limited-/);
  const invalid=await cli(root,'--retention-days=-1');assert.equal(invalid.code,1);assert.match(invalid.errors,/正整数/);
}));

test('媒体读取刷新使用时间，刚读取的旧缓存不进入清理候选',()=>fixture(async({paths,seed,file})=>{
  const {social,usage}=await seed(),saved=await file('recently read');
  const media=new MediaService(paths.media,()=>DEFAULT_SETTINGS.social,undefined,{index:usage.mediaCacheStore});assert.equal((await media.bytes(saved,new AbortController().signal)).buffer.toString(),'recently read');await media.flush();await social.close();await usage.close();
  const result=await cleanupMedia(paths,{dryRun:true});assert.equal(result.eligible,0);assert.equal(result.examined,0);
}));

test('删除后响应丢失不重试，下一次核对修复计数并保留其它文件',()=>fixture(async({paths,seed,file})=>{
  const {social,usage}=await seed();await file('lost reply');await file('untouched');await social.close();await usage.close();let calls=0;
  await assert.rejects(cleanupMedia(paths,{remove:async(root,entry)=>{calls++;await unlink(join(root,entry.name));throw new Error('confirmation lost');}}),/confirmation lost/);assert.equal(calls,1);assert.equal((await readdir(paths.media)).length,1);
  const result=await cleanupMedia(paths,{dryRun:true});assert.equal(result.eligible,1);const db=new DatabaseSync(paths.usage+'.sqlite',{readOnly:true});try{assert.equal(db.prepare("SELECT value FROM runtime_meta WHERE key='media_cache_files'").get().value,'1');}finally{db.close();}
}));

if(process.platform==='win32'){
test('Windows 原生删除真实无引用旧缓存，保留收藏、未知动作、近期内容及用户文件',()=>fixture(async({paths,seed,file,native})=>{
  const {social,usage}=await seed(),free=await file('native-free'),favorite=await file('native-favorite'),unknown=await file('native-unknown');await file('native-recent',Date.now());await writeFile(join(paths.media,'user.txt'),'private');
  await social.update(d=>d.stickers.push({id:'favorite',file:favorite,note:'收藏',tags:[],uses:0,at:1,qqPresent:true}));const op=r({source:unknown});await usage.beginOperation(op);await usage.reserveOperation(op.id,0,quotas);await usage.submitOperation(op.id,0,'upload_private_file',{file:unknown});await usage.failOperation(op.id,'unknown');await social.close();await usage.close();
  const result=await cleanupMedia(paths,{remove:await native()});assert.equal(result.deleted,1);assert.equal(result.protected,2);assert.equal(result.bytes,Buffer.byteLength('native-free'));assert.equal(result.complete,true);await assert.rejects(lstat(free),{code:'ENOENT'});assert.equal(await readFile(favorite,'utf8'),'native-favorite');assert.equal(await readFile(unknown,'utf8'),'native-unknown');assert.equal(await readFile(join(paths.media,'user.txt'),'utf8'),'private');
}));

test('Windows 核验后文件保持独占，替换/写入被拒绝，未授权时完整保留',()=>fixture(async({paths,file,native})=>{
  const saved=await file('exclusive'),remove=await native(),entry={name:basename(saved),size:9};let authorized=0;
  const kept=await remove(paths.media,entry,cutoff,async()=>{authorized++;await assert.rejects(writeFile(saved,'replaced'));await assert.rejects(unlink(saved));return false;},new AbortController().signal);assert.equal(kept.status,'kept');assert.equal(authorized,1);assert.equal(await readFile(saved,'utf8'),'exclusive');
  assert.equal((await remove(paths.media,entry,cutoff,async()=>true,new AbortController().signal)).status,'deleted');await assert.rejects(lstat(saved),{code:'ENOENT'});
}));

test('Windows 拒绝被同大小替换的内容、硬链接、在途读取及近期修改',()=>fixture(async({root,paths,file,native})=>{
  const saved=await file('original'),remove=await native(),entry={name:basename(saved),size:8},call=()=>remove(paths.media,entry,cutoff,async()=>{assert.fail('不应取得删除授权');},new AbortController().signal);
  await writeFile(saved,'replaced');await utimes(saved,new Date(old),new Date(old));assert.equal((await call()).reason,'content');assert.equal(await readFile(saved,'utf8'),'replaced');
  await writeFile(saved,'original');await utimes(saved,new Date(old),new Date(old));const outside=join(root,'original-copy');await link(saved,outside);assert.equal((await call()).reason,'links-or-type');await unlink(outside);
  const handle=await open(saved,'r');try{assert.equal((await call()).reason,'busy');}finally{await handle.close();}
  await utimes(saved,new Date(),new Date());assert.equal((await call()).reason,'changed');assert.equal(await readFile(saved,'utf8'),'original');
}));

test('Windows 媒体目录被换成联接后拒绝删除实际库外的同摘要文件',()=>fixture(async({root,paths,file,native})=>{
  const saved=await file('junction-file'),remove=await native(),moved=join(root,'moved'),outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,basename(saved)),'junction-file');await utimes(join(outside,basename(saved)),new Date(old),new Date(old));
  await rename(paths.media,moved);await symlink(outside,paths.media,'junction');
  const result=await remove(paths.media,{name:basename(saved),size:13},cutoff,async()=>{assert.fail('不能授权库外文件');},new AbortController().signal);assert.equal(result.reason,'path');assert.equal(await readFile(join(outside,basename(saved)),'utf8'),'junction-file');assert.equal(await readFile(join(moved,basename(saved)),'utf8'),'junction-file');
}));

test('Windows 取消等待中的删除授权会关闭原生句柄，文件和共享资源保持可恢复',()=>fixture(async({paths,file,native})=>{
  const saved=await file('cancel-native'),remove=await native(),controller=new AbortController();let entered;const ready=new Promise(done=>entered=done);
  const pending=remove(paths.media,{name:basename(saved),size:13},cutoff,()=>{entered();return new Promise(()=>{});},controller.signal);const rejected=assert.rejects(pending,/native cancelled/);await ready;controller.abort(new Error('native cancelled'));await rejected;assert.equal(await readFile(saved,'utf8'),'cancel-native');await writeFile(saved,'still writable');
}));

test('Windows 实际宿主在文件核验后退出，未收到删除命令的原生助手释放文件且不删除',()=>fixture(async({root,paths,file,native})=>{
  const saved=await file('host-crash');await native();const module=pathToFileURL(resolve('scripts/media-cleaner.mjs')).href,script=join(root,'crash.mjs');
  await writeFile(script,`import{mediaCleanerExecutable,mediaRemover}from ${JSON.stringify(module)};const exe=await mediaCleanerExecutable({root:${JSON.stringify(resolve('.'))},dataRoot:${JSON.stringify(root)}});await mediaRemover(exe)(${JSON.stringify(paths.media)},{name:${JSON.stringify(basename(saved))},size:10},${cutoff},async()=>process.exit(42),new AbortController().signal);`);
  const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
  let text;for(let i=0;i<50;i++){try{text=await readFile(saved,'utf8');break;}catch(error){if(!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;await new Promise(done=>setTimeout(done,50));}}assert.equal(text,'host-crash');
}));

test('Windows 发行布局使用预编译助手、不要求源码或编译器，CLI 实际删除支持中文空格路径',()=>fixture(async({root,paths,seed,file,native})=>{
  const {social,usage}=await seed();const saved=await file('cli-clean');await social.close();await usage.close();const built=await mediaCleanerExecutable({root:resolve('.'),dataRoot:root}),bundle=join(root,'发行 程序');await mkdir(join(bundle,'desktop'),{recursive:true});await cp(built,join(bundle,'desktop/media-cleaner.exe'));
  const executable=await mediaCleanerExecutable({root:bundle,dataRoot:root});assert.equal(executable,join(bundle,'desktop/media-cleaner.exe'));assert.equal((await mediaRemover(executable)(paths.media,{name:basename(saved),size:9},cutoff,async()=>true,new AbortController().signal)).status,'deleted');
  await file('cli-second');const result=await cli(root);assert.equal(result.code,0,result.errors);assert.equal(JSON.parse(result.output).deleted,1);assert.equal((await readdir(paths.media)).length,0);
}));
}
