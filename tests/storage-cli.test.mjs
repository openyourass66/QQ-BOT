import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {SocialStore,SocialDataSchema} from '../dist/qq/social-store.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';

async function run(root,action,...args){const env={...process.env};for(const key of Object.keys(env))if(/^(BOT_|ONEBOT_|SESSION_STORE$)/.test(key))delete env[key];const child=spawn(process.execPath,[resolve('scripts/storage.mjs'),action,'--data-dir',root,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);const [code]=await once(child,'exit');return {code,output,errors};}
const message=id=>({chat:'private:2',id,user:2,name:'朋友',at:Date.now(),text:'fixture-sensitive-message '+id,segments:[],self:false,recalled:false});

test('离线检查、迁移和一致性导出支持自定义路径；导出不覆盖文件且被占用时拒绝操作',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-storage-cli-'));
  try{
    await mkdir(join(root,'custom'));await writeFile(join(root,'.env'),'BOT_SOCIAL_STORE=custom/records.json\nONEBOT_TOKEN=fixture-private-token\n');
    const initial=await run(root,'status');assert.equal(initial.code,0,initial.errors);assert.equal(JSON.parse(initial.output).databaseReady,false);
    const path=join(root,'custom/records.json'),legacy=new SocialStore(path);await legacy.load();await legacy.add(message(1));
    const migrated=await run(root,'migrate');assert.equal(migrated.code,0,migrated.errors);const store=new SqliteSocialStore(path);try{await store.load();await store.add(message(2));}finally{await store.close();}
    const destination=join(root,'private export.json'),exported=await run(root,'export','--output',destination);assert.equal(exported.code,0,exported.errors);assert.equal(JSON.parse(exported.output).messages,2);assert.doesNotMatch(exported.output+exported.errors,/fixture-private-token|fixture-sensitive-message/);
    const text=await readFile(destination,'utf8'),data=SocialDataSchema.parse(JSON.parse(text));assert.deepEqual(data.messages.map(m=>m.id),[1,2]);assert.match(text,/fixture-sensitive-message/);
    const repeated=await run(root,'export','--output',destination);assert.equal(repeated.code,1);assert.equal(await readFile(destination,'utf8'),text);assert.ok(!(await readdir(root)).some(name=>name.includes('.export-')));
    const checked=await run(root,'verify');assert.equal(checked.code,0,checked.errors);assert.deepEqual(JSON.parse(checked.output).check,['ok']);
    const lease=await acquireDataResources(mutableDataResources(dataPaths({BOT_SOCIAL_STORE:'custom/records.json'},root)));try{const busy=await run(root,'export','--output',join(root,'refused.json'));assert.equal(busy.code,1);assert.match(busy.errors,/资源正在使用/);}finally{lease.release();}
    await writeFile(path,(await readFile(path,'utf8'))+'\n');assert.equal((await run(root,'verify')).code,1);assert.equal((await run(root,'export','--output',join(root,'for-review.json'))).code,0,'源文件发生变化后仍可导出数据库，供人工核对');
  }finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});

test('迁移宿主强制退出后不激活半成品，再次启动从完整原文恢复',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-migration-crash-'));
  try{
    const path=join(root,'social.json'),legacy=new SocialStore(path);await legacy.load();await legacy.update(d=>{d.messages=Array.from({length:600},(_,i)=>message(i));});const before=await readFile(path);
    const script=join(root,'crash.mjs');await writeFile(script,`import{ensureSocialDatabase}from ${JSON.stringify(pathToFileURL(resolve('dist/storage/social-migration.js')).href)};await ensureSocialDatabase(${JSON.stringify(path)},progress=>{if(progress.stage==='import')process.exit(42)});`);
    const child=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});const [code]=await once(child,'exit');assert.equal(code,42);assert.deepEqual(await readFile(path),before);assert.ok(!(await readdir(root)).includes('social.json.sqlite'));assert.ok((await readdir(root)).some(name=>name.startsWith('social.json.sqlite.migration-')));
    const restored=new SqliteSocialStore(path);try{await restored.load();assert.equal((await restored.queryMessages({})).total,600);}finally{await restored.close();}
    assert.deepEqual(await readFile(path),before);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
