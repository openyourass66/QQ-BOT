import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {scryptSync,createDecipheriv,createCipheriv,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createBackup,verifyBackup,restoreBackup,recoverMaintenance,maintenanceStatus} from '../scripts/maintenance.mjs';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {prepareRuntime,assertNoPendingRestore} from '../scripts/app-paths.mjs';

const secret='fixture-backup-password-2026';
const names=['sessions','group-context','daily-usage','social'];
function database(path,value){const db=new DatabaseSync(path);try{db.exec('CREATE TABLE IF NOT EXISTS records(value TEXT)');db.exec('DELETE FROM records');db.prepare('INSERT INTO records VALUES(?)').run(value);}finally{db.close();}}
function value(path){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT value FROM records').get().value;}finally{db.close();}}
async function fixture(run){
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'qq-maintenance-test-')),dataRoot=join(root,'中文 实例'),file=join(root,'备份.wwbackup');
  try{
    for(const dir of ['data/media/empty','bot-workspace/memory','bot-workspace/.whale','.credentials'])await mkdir(join(dataRoot,dir),{recursive:true});
    await writeFile(join(dataRoot,'.env'),"BOT_WORKSPACE=bot-workspace\nQQ_BOT_DEEPSEEK_API_KEY='fixture-private-token'\n");await writeFile(join(dataRoot,'bot.config.json'),'{}');
    await writeFile(join(dataRoot,'bot-workspace/AGENTS.md'),'原人设');await writeFile(join(dataRoot,'bot-workspace/memory/notes.md'),'私人记忆正文');await writeFile(join(dataRoot,'bot-workspace/.whale/personas.json'),'{"version":1,"personas":[]}');
    await writeFile(join(dataRoot,'data/media/fixture.bin'),Buffer.from([0,1,2,254,255]));await writeFile(join(dataRoot,'.credentials/fixture.json'),'{"ciphertext":"fixture-encrypted-material"}');
    for(const name of names){await writeFile(join(dataRoot,'data',name+'.json'),'{"fixture":"original"}');database(join(dataRoot,'data',name+'.json.sqlite'),'original');}
    const options={dataRoot,file,password:secret};await run({root,dataRoot,file,options});
  }finally{const actual=await realpath(root);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('qq-maintenance-test-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}
async function change(dataRoot){
  await writeFile(join(dataRoot,'.env'),'BOT_WORKSPACE=bot-workspace\nQQ_BOT_DEEPSEEK_API_KEY=changed-private-token\n');await writeFile(join(dataRoot,'bot-workspace/memory/notes.md'),'新记忆');await writeFile(join(dataRoot,'data/media/fixture.bin'),'new-media');await writeFile(join(dataRoot,'data/media/new.bin'),'new-file');
  for(const name of names)database(join(dataRoot,'data',name+'.json.sqlite'),'changed');
}
async function original(dataRoot){assert.match(await readFile(join(dataRoot,'.env'),'utf8'),/fixture-private-token/);assert.equal(await readFile(join(dataRoot,'bot-workspace/memory/notes.md'),'utf8'),'私人记忆正文');for(const name of names)assert.equal(value(join(dataRoot,'data',name+'.json.sqlite')),'original');}
async function crash(options,stage,id){
  const module=pathToFileURL(resolve('scripts/maintenance.mjs')).href;
  const code=`import{restoreBackup}from ${JSON.stringify(module)};let input='';for await(const chunk of process.stdin)input+=chunk;const options=JSON.parse(input);await restoreBackup({...options,checkpoint:(stage,id)=>{if(stage===${JSON.stringify(stage)}&&(${JSON.stringify(id)}===null||id===${JSON.stringify(id)}))process.exit(42);}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['pipe','ignore','pipe']});let errors='';child.stderr.on('data',chunk=>errors+=chunk);child.stdin.end(JSON.stringify(options));assert.equal((await once(child,'exit'))[0],42,errors);
}

test('加密备份覆盖四库、原始配置、人设、记忆、媒体、密文凭据及空目录，恢复前保存当前恢复点',()=>fixture(async({dataRoot,file,options})=>{
  const result=await createBackup(options);assert.ok(result.files>=15);const bytes=await readFile(file);assert.ok(!bytes.includes(Buffer.from('fixture-private-token')));assert.ok(!bytes.includes(Buffer.from('私人记忆正文')));
  const verified=await verifyBackup(options);assert.equal(verified.files,result.files);assert.equal(verified.bytes,result.bytes);
  await change(dataRoot);const restored=await restoreBackup(options);assert.equal(restored.restartRequired,true);await original(dataRoot);assert.deepEqual(await readFile(join(dataRoot,'data/media/fixture.bin')),Buffer.from([0,1,2,254,255]));assert.deepEqual(await readdir(join(dataRoot,'data/media/empty')),[]);await assert.rejects(readFile(join(dataRoot,'data/media/new.bin')),{code:'ENOENT'});assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);
  await restoreBackup({...options,file:restored.recoveryPoint});assert.equal(value(join(dataRoot,'data/sessions.json.sqlite')),'changed');assert.equal(await readFile(join(dataRoot,'bot-workspace/memory/notes.md'),'utf8'),'新记忆');
}));

test('错误密码、篡改和截断备份不切换任何当前数据',()=>fixture(async({dataRoot,file,options})=>{
  await createBackup(options);await change(dataRoot);const raw=await readFile(file);
  await assert.rejects(restoreBackup({...options,password:'fixture-incorrect-password'}),/密码错误|损坏/);
  raw[raw.length-20]^=1;await writeFile(file,raw);await assert.rejects(restoreBackup(options),/密码错误|损坏/);
  await writeFile(file,raw.subarray(0,raw.length-40));await assert.rejects(restoreBackup(options),/密码错误|损坏/);
  assert.equal(value(join(dataRoot,'data/sessions.json.sqlite')),'changed');assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);await assert.rejects(readdir(join(dataRoot,'backups')),{code:'ENOENT'});
}));

test('备份不覆盖既有文件，运行实例占用资源时拒绝维护',()=>fixture(async({dataRoot,file,options})=>{
  await writeFile(file,'keep');await assert.rejects(createBackup(options),/目标已存在/);assert.equal(await readFile(file,'utf8'),'keep');await rm(file);
  const lease=await acquireDataResources(mutableDataResources(dataPaths({},dataRoot)));try{await assert.rejects(createBackup(options),{code:'BOT_RESOURCE_LOCKED'});}finally{lease.release();}await assert.rejects(readFile(file),{code:'ENOENT'});
}));

test('取消备份删除本次半成品且不改变原数据',()=>fixture(async({root,dataRoot,file,options})=>{
  const cancel=new AbortController();await assert.rejects(createBackup({...options,signal:cancel.signal,onProgress:event=>{if(event.stage==='reading'&&event.files>0)cancel.abort(new Error('fixture-cancel'));}}),/fixture-cancel/);
  await assert.rejects(readFile(file),{code:'ENOENT'});assert.ok(!(await readdir(root)).some(name=>name.includes('.partial-')));await original(dataRoot);
}));

test('切换发生异常时还原所有原数据并保留加密恢复点',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await change(dataRoot);await assert.rejects(restoreBackup({...options,checkpoint:(stage,id)=>{if(stage==='original-moved'&&id==='media')throw new Error('fixture-switch-failure');}}),/fixture-switch-failure/);
  assert.equal(value(join(dataRoot,'data/sessions.json.sqlite')),'changed');assert.equal(await readFile(join(dataRoot,'data/media/fixture.bin'),'utf8'),'new-media');assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);assert.equal((await readdir(join(dataRoot,'backups'))).length,1);
}));

test('宿主在配置切换间隙退出后启动和初始化均不读取半恢复数据，恢复入口可撤回',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await change(dataRoot);await crash(options,'original-moved','env');assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,true);
  assert.throws(()=>mutableDataResources(dataPaths({},dataRoot)),{code:'MAINTENANCE_RECOVERY_REQUIRED'});await prepareRuntime({root:process.cwd(),args:['--data-dir',dataRoot]});await assert.rejects(readFile(join(dataRoot,'.env')),{code:'ENOENT'});
  const result=await recoverMaintenance({dataRoot});assert.equal(result.recovered,true);assert.equal(result.committed,false);assert.match(await readFile(join(dataRoot,'.env'),'utf8'),/changed-private-token/);assert.equal(value(join(dataRoot,'data/social.json.sqlite')),'changed');assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);
}));

test('提交完成后宿主退出只收尾旧文件，不将已恢复的数据退回',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await change(dataRoot);await crash(options,'committed',null);const result=await recoverMaintenance({dataRoot});assert.equal(result.committed,true);await original(dataRoot);assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);
}));

test('中断后人工修改目标时保留新旧数据，不自动覆盖编辑',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await change(dataRoot);await crash(options,'installed','settings');await writeFile(join(dataRoot,'bot.config.json'),'manual-edit');await assert.rejects(recoverMaintenance({dataRoot}),/编辑|改变/);assert.equal(await readFile(join(dataRoot,'bot.config.json'),'utf8'),'manual-edit');assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,true);
}));

test('拒绝链接、备份目标嵌套、重叠数据目录及不同实例恢复',()=>fixture(async({root,dataRoot,options})=>{
  await assert.rejects(createBackup({...options,file:join(dataRoot,'data/media/backup.wwbackup')}),/不能保存/);await createBackup(options);
  if(process.platform==='win32'){
    const probe=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$fixtureFs=New-Object -ComObject Scripting.FileSystemObject;$fixtureFs.GetFolder($env:FIXTURE_SHORT_ROOT).ShortPath"],{encoding:'utf8',windowsHide:true,env:{...process.env,FIXTURE_SHORT_ROOT:dataRoot}});assert.equal(probe.status,0,probe.stderr);const alias=probe.stdout.trim();assert.equal(await realpath(alias),await realpath(dataRoot));
    await assert.rejects(createBackup({...options,file:join(alias,'data/media/backup.wwbackup')}),/不能保存/);
    const nested=join(alias,'data/media/keep.wwbackup');await writeFile(nested,await readFile(options.file));await assert.rejects(restoreBackup({...options,file:nested}),/目录之外/);await rm(nested);
  }
  const other=join(root,'other');await mkdir(other);await writeFile(join(other,'.env'),'');await assert.rejects(restoreBackup({...options,dataRoot:other}),/原实例/);
  await mkdir(join(root,'outside'));await writeFile(join(root,'outside','keep'),'keep');await symlink(join(root,'outside'),join(dataRoot,'bot-workspace/memory/link'),process.platform==='win32'?'junction':'dir');await assert.rejects(createBackup({...options,file:join(root,'linked.wwbackup')}),/链接/);assert.equal(await readFile(join(root,'outside/keep'),'utf8'),'keep');
}));

test('当前数据库损坏时仍可保存故障恢复点并从有效备份恢复',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await writeFile(join(dataRoot,'data/social.json.sqlite'),'corrupt-database-original');const result=await restoreBackup(options);await original(dataRoot);assert.ok((await readFile(result.recoveryPoint)).length>100);
}));

test('恢复在提交前取消会撤回原数据，错误后不遗留无主暂存文件',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await change(dataRoot);const cancel=new AbortController();await assert.rejects(restoreBackup({...options,signal:cancel.signal,checkpoint:(stage,id)=>{if(stage==='installed'&&id==='media')cancel.abort(new Error('fixture-restore-cancel'));}}),/fixture-restore-cancel/);assert.equal(value(join(dataRoot,'data/sessions.json.sqlite')),'changed');assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);
}));

test('备份数据库版本较新时拒绝恢复，备份位于待恢复目录内时保留源文件',()=>fixture(async({dataRoot,options})=>{
  const db=new DatabaseSync(join(dataRoot,'data/social.json.sqlite'));db.exec('PRAGMA user_version=999');db.close();await createBackup(options);await assert.rejects(verifyBackup(options),/版本较新/);await assert.rejects(restoreBackup(options),/版本较新/);assert.equal((await maintenanceStatus(dataRoot)).recoveryPending,false);
  const nested=join(dataRoot,'data/media/keep.wwbackup');await writeFile(nested,await readFile(options.file));await assert.rejects(restoreBackup({...options,file:nested}),/目录之外/);assert.ok((await readFile(nested)).length>100);
}));

test('真实四库仓储恢复后仍能校验迁移来源并重新打开使用',()=>fixture(async({dataRoot,options})=>{
  for(const name of names)for(const suffix of ['.json','.json.sqlite'])await rm(join(dataRoot,'data',name+suffix));
  const {SqliteSessionStore,SqliteGroupContextStore}=await import('../dist/storage/sqlite-runtime-stores.js');const {SqliteDailyUsageStore}=await import('../dist/storage/sqlite-usage-store.js');const {SqliteSocialStore}=await import('../dist/storage/sqlite-social-store.js');
  const make=()=>[new SqliteSessionStore(join(dataRoot,'data/sessions.json')),new SqliteGroupContextStore(join(dataRoot,'data/group-context.json')),new SqliteDailyUsageStore(join(dataRoot,'data/daily-usage.json')),new SqliteSocialStore(join(dataRoot,'data/social.json'))];
  let stores=make();try{for(const store of stores)await store.load();stores[0].set('private:10000','original-session');await stores[2].consume(()=>[{key:'fixture',limit:10,amount:1,label:'fixture'}]);for(const store of stores)await store.close();await createBackup(options);stores=make();for(const store of stores)await store.load();stores[0].set('private:10000','changed-session');for(const store of stores)await store.close();await restoreBackup(options);stores=make();for(const store of stores)await store.load();assert.equal(stores[0].get('private:10000'),'original-session');assert.equal(stores[2].used('fixture'),1);}finally{await Promise.allSettled(stores.map(store=>store.close()));}
}));

test('已认证的恶意备份路径仍被拒绝，不写出暂存目录',()=>fixture(async({root,dataRoot,options})=>{
  await createBackup(options);const raw=await readFile(options.file),size=raw.readUInt32BE(9),header=JSON.parse(raw.subarray(13,13+size).toString()),key=scryptSync(secret,Buffer.from(header.salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(header.iv,'base64'));decipher.setAAD(raw.subarray(0,13+size));decipher.setAuthTag(raw.subarray(-16));const text=gunzipSync(Buffer.concat([decipher.update(raw.subarray(13+size,-16)),decipher.final()])).toString('utf8'),records=text.trimEnd().split('\n').map(JSON.parse);records.find(row=>row.type==='file').name='../../escaped';header.iv=randomBytes(12).toString('base64');const encoded=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(4);length.writeUInt32BE(encoded.length);const aad=Buffer.concat([raw.subarray(0,9),length,encoded]),cipher=createCipheriv('aes-256-gcm',key,Buffer.from(header.iv,'base64'));cipher.setAAD(aad);await writeFile(options.file,Buffer.concat([aad,cipher.update(gzipSync(records.map(row=>JSON.stringify(row)).join('\n')+'\n')),cipher.final(),cipher.getAuthTag()]));await assert.rejects(restoreBackup(options),/损坏|格式/);await original(dataRoot);await assert.rejects(readFile(join(root,'escaped')),{code:'ENOENT'});
}));

test('恢复记录路径被篡改时拒绝操作外部文件',()=>fixture(async({root,dataRoot,options})=>{
  await createBackup(options);await change(dataRoot);await crash(options,'installed','settings');const path=join(dataRoot,'.restore-journal.json'),before=await readFile(path,'utf8'),journal=JSON.parse(before),outside=join(root,'outside-file');await writeFile(outside,'keep');journal.entries[0].target=outside;await writeFile(path,JSON.stringify(journal));await assert.rejects(recoverMaintenance({dataRoot}),/路径|摘要/);assert.equal(await readFile(outside,'utf8'),'keep');await writeFile(path,before);await recoverMaintenance({dataRoot});
}));

test('恢复标记被替换为失效链接时仍禁止启动或补建配置',()=>fixture(async({root,dataRoot})=>{
  await symlink(join(root,'missing'),join(dataRoot,'.restore-journal.json'),process.platform==='win32'?'junction':'dir');await rm(join(dataRoot,'.env'));assert.throws(()=>assertNoPendingRestore(dataRoot),{code:'MAINTENANCE_RECOVERY_REQUIRED'});assert.throws(()=>mutableDataResources(dataPaths({},dataRoot)),{code:'MAINTENANCE_RECOVERY_REQUIRED'});await prepareRuntime({root:process.cwd(),args:['--data-dir',dataRoot]});await assert.rejects(readFile(join(dataRoot,'.env')),{code:'ENOENT'});
}));

test('备份中的机器人设置损坏时在切换前拒绝，当前坏配置也能通过有效备份恢复',()=>fixture(async({dataRoot,options})=>{
  await createBackup(options);await writeFile(join(dataRoot,'bot.config.json'),'broken-current-settings');await restoreBackup(options);assert.equal(await readFile(join(dataRoot,'bot.config.json'),'utf8'),'{}');
  await writeFile(join(dataRoot,'bot.config.json'),'broken-backup-settings');await createBackup({...options,file:options.file+'.bad.wwbackup'});await writeFile(join(dataRoot,'bot.config.json'),'{}');await assert.rejects(restoreBackup({...options,file:options.file+'.bad.wwbackup'}),/设置损坏/);assert.equal(await readFile(join(dataRoot,'bot.config.json'),'utf8'),'{}');
}));
