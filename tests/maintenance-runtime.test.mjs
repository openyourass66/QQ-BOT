import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,realpath} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {copyRuntimeHost} from './helpers/runtime.mjs';
import {runtimeLayout} from '../scripts/app-paths.mjs';
import {pathToFileURL} from 'node:url';

test('桌面维护复用运行管理互斥；停止后可备份，取消不排队，密码不进入事件和日志',async()=>{
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'qq-maintenance-host-')),app=join(root,'app'),dataRoot=join(root,'data'),file=join(root,'backup.wwbackup'),password='fixture-backup-private-password';let service,cancelNext=false,cancelled=false;
  const events=[];
  try{
    await copyRuntimeHost(app);await mkdir(dataRoot);await mkdir(join(dataRoot,'bot-workspace'),{recursive:true});await writeFile(join(dataRoot,'.env'),'BOT_WORKSPACE=bot-workspace\nBOT_ONEBOT_MODE=managed\n');await writeFile(join(dataRoot,'bot-workspace/AGENTS.md'),'fixture-persona');
    for(const file of ['scripts/maintenance.mjs','desktop/maintenance-worker.mjs','dist/core/data-paths.js','dist/storage/database-types.js']){await mkdir(dirname(join(app,file)),{recursive:true});await cp(resolve(file),join(app,file));}
    await writeFile(join(app,'desktop/diagnostics.mjs'),"export async function diagnose(){return {ok:true,rows:[]}};export async function environment(){return {BOT_ONEBOT_MODE:'managed'}};export async function onebotOnline(){return false};");
    await writeFile(join(app,'dist/bridge.js'),"process.on('message',m=>{if(m==='shutdown')process.exit();});setInterval(()=>{},1000);");await writeFile(join(app,'scripts/napcat-node.mjs'),'setInterval(()=>{},1000);');
    const {createRuntimeService}=await import(pathToFileURL(join(app,'scripts/runtime-service.mjs')).href);
    service=await createRuntimeService({root:app,layout:await runtimeLayout({root:app,args:['--data-dir',dataRoot]}),onEvent:event=>{events.push(event);if(cancelNext&&!cancelled&&event.type==='maintenance-progress'){cancelled=true;void service.receive({action:'maintenance-cancel'});}}});
    assert.equal((await service.receive({action:'start'})).ok,true);await assert.rejects(service.receive({action:'maintenance',data:{operation:'backup',file,password}}),/先停止/);
    await service.receive({action:'stop'});await service.receive({action:'maintenance',data:{operation:'backup',file,password}});assert.ok(events.some(event=>event.type==='maintenance'&&event.operation==='backup'));
    cancelNext=true;const pending=service.receive({action:'maintenance',data:{operation:'backup',file:join(root,'cancelled.wwbackup'),password}});
    await assert.rejects(service.receive({action:'start'}),/维护/);await assert.rejects(service.updateConfiguration({}),/维护/);await assert.rejects(pending,/取消/);assert.equal(cancelled,true);await assert.rejects(readFile(join(root,'cancelled.wwbackup')),{code:'ENOENT'});
    assert.ok(!JSON.stringify(events).includes(password));assert.ok(!(await readFile(join(dataRoot,'data/desktop/console.log'),'utf8')).includes(password));
    await writeFile(join(dataRoot,'.restore-journal.json'),'{}');await assert.rejects(service.receive({action:'start'}),{code:'MAINTENANCE_RECOVERY_REQUIRED'});await rm(join(dataRoot,'.restore-journal.json'));
  }finally{await service?.close();const actual=await realpath(root);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('qq-maintenance-host-'));await rm(actual,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
