import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,lstat,open,opendir,link,unlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {MediaCache,MEDIA_WRITE_LIMITS} from '../dist/services/media-cache.js';
import {MemoryMediaCacheStore} from '../dist/storage/memory-media-cache.js';
import {SqliteDailyUsageStore} from '../dist/storage/sqlite-usage-store.js';

const name=bytes=>createHash('sha256').update(bytes).digest('hex')+'.png';
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-media-cache-')),path=join(root,'usage.json'),media=join(root,'媒体 media'),resources=[];const keep=value=>{resources.push(value);return value;};try{await mkdir(media);await run({root,path,media,keep});}finally{await Promise.allSettled(resources.map(value=>value.close?.()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
async function ready(store,entries=[]){await store.call({action:'media-cache-scan-start',root:'test-root',owner:'scan'});if(entries.length)await store.call({action:'media-cache-scan-batch',owner:'scan',entries});return store.call({action:'media-cache-scan-complete',owner:'scan'});}

for(const implementation of ['memory','sqlite'])test(`${implementation} 媒体索引：容量预留原子化、阶段与持有者匹配、无效批次完整回滚`,()=>fixture(async({path,keep})=>{
  const usage=implementation==='sqlite'?keep(new SqliteDailyUsageStore(path)):undefined;if(usage)await usage.load();const store=usage?.mediaCacheStore??new MemoryMediaCacheStore();
  const first={name:'existing.png',size:7,mtime:1,owned:false};assert.deepEqual(await ready(store,[first]),{files:1,bytes:7});
  const reserve={action:'media-cache-reserve',name:'new.png',size:3,limit:10,owner:'writer'};await store.call(reserve);
  await assert.rejects(store.call({...reserve,name:'overflow.png',size:1}),error=>error.code==='DATABASE_MEDIA_QUOTA');
  await assert.rejects(store.call({...reserve,owner:'other'}),error=>error.code==='DATABASE_MEDIA_BUSY');
  await assert.rejects(store.call({action:'media-cache-scan-start',root:'test-root',owner:'scan2'}),error=>error.code==='DATABASE_MEDIA_BUSY');
  await assert.rejects(store.call({action:'media-cache-complete',name:'new.png',owner:'writer',mtime:2,at:2}),error=>error.code==='DATABASE_MEDIA_INVALID');
  await assert.rejects(store.call({action:'media-cache-stage',name:'new.png',owner:'other',fileTag:'1:2'}),error=>error.code==='DATABASE_MEDIA_INVALID');
  await store.call({action:'media-cache-stage',name:'new.png',owner:'writer',fileTag:'1:2'});
  await store.call({action:'media-cache-abort',name:'new.png',owner:'other'});assert.deepEqual(await store.call({action:'media-cache-statistics'}),{files:2,bytes:10});
  await store.call({action:'media-cache-complete',name:'new.png',owner:'writer',mtime:2,at:3});
  await store.call({action:'media-cache-scan-start',root:'test-root',owner:'scan2'});
  await assert.rejects(store.call({action:'media-cache-scan-batch',owner:'scan2',entries:[{...first,size:99},{...first,name:'../escape'}]}),error=>error.code==='DATABASE_MEDIA_INVALID');
  assert.equal((await store.call({action:'media-cache-read',name:first.name})).size,7);
  await store.call({action:'media-cache-scan-batch',owner:'scan2',entries:[first]});assert.deepEqual(await store.call({action:'media-cache-scan-complete',owner:'scan2'}),{files:1,bytes:7});
  await store.call(reserve);await store.call({action:'media-cache-stage',name:'new.png',owner:'writer',fileTag:'1:2'});await store.call({action:'media-cache-recover'});
  assert.equal((await store.call({action:'media-cache-read',name:'new.png'})).state,'stale');
  assert.deepEqual((await store.call({action:'media-cache-scan-start',root:'test-root',owner:'recovery'})).stale,[{name:'new.png',owner:'writer',fileTag:'1:2'}]);
}));

test('首次扫描后保存二十个文件只做固定数量文件检查；显式核对发现外部增删且不删除用户文件',()=>fixture(async({media,path,keep})=>{
  await Promise.all(Array.from({length:200},(_,i)=>writeFile(join(media,`user-${i}.png`),'x')));const usage=keep(new SqliteDailyUsageStore(path));await usage.load();let scans=0,stats=0;
  const cache=new MediaCache(media,usage.mediaCacheStore,{fs:{opendir:async(...args)=>{scans++;return opendir(...args);},lstat:async(...args)=>{stats++;return lstat(...args);}}});
  assert.deepEqual(await cache.statistics(),{files:200,bytes:200});const initial=stats;
  for(let i=0;i<20;i++)await cache.save(Buffer.from(`image-${i}`),'.png');assert.equal(scans,1);assert.ok(stats-initial<=60,`每次保存不应遍历目录，实际检查 ${stats-initial}`);
  const bytes=Array.from({length:20},(_,i)=>Buffer.byteLength(`image-${i}`)).reduce((a,b)=>a+b,0);assert.deepEqual(await cache.statistics(),{files:220,bytes:200+bytes});
  await unlink(join(media,'user-0.png'));await writeFile(join(media,'外部文件.txt'),'external');assert.deepEqual(await cache.reconcile(),{files:220,bytes:199+bytes+8});assert.equal(scans,2);assert.equal(await readFile(join(media,'外部文件.txt'),'utf8'),'external');
}));

test('保存入口复制材料，队列八项上限在等待期间生效，超限不会占用文件或空间',()=>fixture(async({media})=>{
  let entered,release;const ready=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});let first=true;const store=new MemoryMediaCacheStore();
  const cache=new MediaCache(media,store,{fs:{open:async(...args)=>{if(args[1]==='wx'&&first){first=false;entered();await gate;}return open(...args);}}});
  const input=Buffer.from('original'),one=cache.save(input,'.PNG');input.fill(0);await ready;const rest=Array.from({length:7},(_,i)=>cache.save(Buffer.from('next'+i),'.png'));
  try{assert.equal(cache.queued,8);await assert.rejects(cache.save(Buffer.from('overflow'),'.png'),error=>error.code==='MEDIA_WRITE_BUSY');}finally{release();}
  const file=await one;await Promise.all(rest);await cache.flush();assert.equal(cache.queued,0);assert.equal(cache.queuedBytes,0);assert.equal(await readFile(file,'utf8'),'original');assert.equal((await cache.statistics()).files,8);
}));

test('待写字节与单文件大小有限，配额拒绝发生在文件创建前',()=>fixture(async({media})=>{
  let entered,release;const ready=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});let first=true;
  const cache=new MediaCache(media,undefined,{fs:{open:async(...args)=>{if(args[1]==='wx'&&first){first=false;entered();await gate;}return open(...args);}}});
  const big=Buffer.alloc(MEDIA_WRITE_LIMITS.file),one=cache.save(big,'.png');await ready;const two=cache.save(big,'.png');
  try{await assert.rejects(cache.save(big,'.png'),error=>error.code==='MEDIA_WRITE_BUSY');await assert.rejects(cache.save(Buffer.alloc(MEDIA_WRITE_LIMITS.file+1),'.png'),/单次保存/);}finally{release();}
  assert.equal(await one,await two);assert.deepEqual(await cache.statistics(),{files:1,bytes:big.length});
  const limited=new MediaCache(media,undefined,{limit:()=>big.length});await assert.rejects(limited.save(Buffer.from('extra'),'.png'),error=>error.code==='DATABASE_MEDIA_QUOTA');await assert.rejects(limited.save(Buffer.from('x'),'../bad'),/扩展名/);assert.equal((await readdir(media)).length,1);
}));

test('缓存内容被同大小替换时拒绝复用，保留现有文件且不覆盖',()=>fixture(async({media})=>{
  const cache=new MediaCache(media),bytes=Buffer.from('original'),file=await cache.save(bytes,'.png');await writeFile(file,'replaced');await assert.rejects(cache.save(bytes,'.png'),/内容摘要/);assert.equal(await readFile(file,'utf8'),'replaced');
}));

test('磁盘写入失败撤销未发布预留并停止新保存，失败通知只发一次',()=>fixture(async({media})=>{
  let failures=0;const store=new MemoryMediaCacheStore(),error=Object.assign(new Error('disk full'),{code:'ENOSPC'}),cache=new MediaCache(media,store,{onFailure:()=>failures++,fs:{link:async()=>{throw error;}}});await writeFile(join(media,'user.txt'),'keep');
  await assert.rejects(cache.save(Buffer.from('image'),'.png'),e=>e===error);await assert.rejects(cache.save(Buffer.from('another'),'.png'),e=>e===error);assert.equal(failures,1);assert.deepEqual(await readdir(media),['user.txt']);assert.deepEqual(await store.call({action:'media-cache-statistics'}),{files:1,bytes:4});
}));

test('排他创建遇到已有临时文件时保留该文件，下一次保存使用新凭证',()=>fixture(async({media})=>{
  let foreign,first=true;const cache=new MediaCache(media,undefined,{fs:{open:async(...args)=>{if(args[1]==='wx'&&first){first=false;foreign=args[0];await writeFile(foreign,'foreign');}return open(...args);}}});
  await assert.rejects(cache.save(Buffer.from('image'),'.png'),error=>error.code==='EEXIST');assert.equal(await readFile(foreign,'utf8'),'foreign');const saved=await cache.save(Buffer.from('image'),'.png');assert.equal(await readFile(saved,'utf8'),'image');assert.equal(await readFile(foreign,'utf8'),'foreign');assert.deepEqual(await cache.reconcile(),{files:2,bytes:12});
}));

async function crashWriter({root,path,media},published){
  const script=join(root,'crash.mjs'),usageUrl=pathToFileURL(resolve('dist/storage/sqlite-usage-store.js')).href,cacheUrl=pathToFileURL(resolve('dist/services/media-cache.js')).href;
  await writeFile(script,`import{link}from'node:fs/promises';import{SqliteDailyUsageStore}from ${JSON.stringify(usageUrl)};import{MediaCache}from ${JSON.stringify(cacheUrl)};const usage=new SqliteDailyUsageStore(${JSON.stringify(path)});await usage.load();const cache=new MediaCache(${JSON.stringify(media)},usage.mediaCacheStore,{fs:{link:async(...args)=>{${published?'await link(...args);':''}process.exit(42);}}});await cache.save(Buffer.from('image'),'.png');`);
  const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],42);
}
for(const published of [false,true])test(`实际宿主在${published?'发布后':'发布前'}退出，重启只清理由文件标识证明归属的临时项`,()=>fixture(async args=>{
  await crashWriter(args,published);const {path,media,keep}=args;assert.ok((await readdir(media)).some(name=>name.endsWith('.tmp')));const usage=keep(new SqliteDailyUsageStore(path));await usage.load();const cache=new MediaCache(media,usage.mediaCacheStore);
  assert.deepEqual(await cache.statistics(),{files:published?1:0,bytes:published?5:0});assert.ok((await readdir(media)).every(name=>!name.endsWith('.tmp')));assert.equal(await readFile(await cache.save(Buffer.from('image'),'.png'),'utf8'),'image');assert.deepEqual(await cache.statistics(),{files:1,bytes:5});
}));

test('中断后的临时路径已被换成其它文件时，恢复保留替代文件和原始资料',()=>fixture(async args=>{
  await crashWriter(args,false);const {path,media,root,keep}=args,temp=(await readdir(media)).find(name=>name.endsWith('.tmp')),original=join(root,'original.txt');await writeFile(original,'private-original');await unlink(join(media,temp));await link(original,join(media,temp));
  const usage=keep(new SqliteDailyUsageStore(path));await usage.load();const cache=new MediaCache(media,usage.mediaCacheStore);assert.deepEqual(await cache.statistics(),{files:1,bytes:16});assert.equal(await readFile(join(media,temp),'utf8'),'private-original');assert.equal(await readFile(original,'utf8'),'private-original');
}));

test('发布成功但索引确认失败后停止保存；重启保留已发布文件并正确统计一次',()=>fixture(async({path,media,keep})=>{
  const usage=keep(new SqliteDailyUsageStore(path));await usage.load();let failures=0;const store={call:r=>r.action==='media-cache-complete'?Promise.reject(new Error('confirmation lost')):usage.mediaCacheStore.call(r)},cache=new MediaCache(media,store,{onFailure:()=>failures++});
  await assert.rejects(cache.save(Buffer.from('image'),'.png'),/confirmation lost/);await assert.rejects(cache.save(Buffer.from('another'),'.png'),/confirmation lost/);assert.equal(failures,1);assert.deepEqual(await readdir(media),[name(Buffer.from('image'))]);await usage.close();
  const reopened=keep(new SqliteDailyUsageStore(path));await reopened.load();const recovered=new MediaCache(media,reopened.mediaCacheStore);assert.deepEqual(await recovered.statistics(),{files:1,bytes:5});await recovered.save(Buffer.from('image'),'.png');assert.deepEqual(await recovered.statistics(),{files:1,bytes:5});
}));

test('schema 7 升级媒体索引时保留旧额度，拒绝未来 schema',()=>fixture(async({path,keep})=>{
  const usage=keep(new SqliteDailyUsageStore(path));await usage.load();await usage.consume(()=>[{key:'test',amount:3,limit:10,label:'测试'}]);await usage.close();let db=new DatabaseSync(path+'.sqlite');db.exec('DROP TABLE media_cache_files;PRAGMA user_version=7;');db.close();
  const upgraded=keep(new SqliteDailyUsageStore(path));await upgraded.load();assert.equal(upgraded.used('test'),3);assert.deepEqual(await ready(upgraded.mediaCacheStore),{files:0,bytes:0});await upgraded.close();db=new DatabaseSync(path+'.sqlite');assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);db.exec('PRAGMA user_version=999;');db.close();const future=keep(new SqliteDailyUsageStore(path));await assert.rejects(future.load(),/版本|schema/i);
}));
