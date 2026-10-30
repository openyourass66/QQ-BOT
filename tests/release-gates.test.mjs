import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {validateAcceptance} from '../scripts/check-release-gates.mjs';

async function fixture(run){const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'qq-release-gates-'));try{await mkdir(join(root,'docs/validation'),{recursive:true});await writeFile(join(root,'docs/validation/evidence.json'),'{}');await run(root);}finally{const actual=await realpath(root);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('qq-release-gates-'));await rm(actual,{recursive:true,force:true});}}
function accepted(){const gates=Object.fromEntries(['G01','G02','G03','G04','G05','G06'].map(id=>[id,{status:'passed',evidenceFiles:['docs/validation/evidence.json']}]));Object.assign(gates.G01,{windows10x64:true,windows11x64:true,newUsers:5,successfulNewUsers:4});Object.assign(gates.G02,{negativePermissions:true,nativeToolBoundary:true});gates.G03.lockMigrationBackupRestoreUpgradeRollback=true;Object.assign(gates.G04,{performancePassed:true,mixedLoadHours:72,realUseDays:7,memoryGrowthPercent:10});Object.assign(gates.G05,{fixedDependencyCiPassed:true,manifestPublisherVerified:true,nativePublisherVerified:true,licensesChecked:true,ciRunUrl:'https://github.com/fixture/repo/actions/runs/123'});Object.assign(gates.G06,{maintenanceWalkthrough:true,upgradeRepairDiagnosticsRetentionDocs:true});return {formatVersion:1,appId:'whale-workbench',codeInputTreeSha256:'a'.repeat(64),gates};}
test('正式验收拒绝缺失、过期代码和证据路径，不把内部签名当作正式发布通过',()=>fixture(async root=>{
  const record=accepted(),options={root,record,codeInputTreeSha256:'a'.repeat(64)};assert.equal((await validateAcceptance(options)).ready,true);record.codeInputTreeSha256='b'.repeat(64);assert.equal((await validateAcceptance(options)).ready,false);record.codeInputTreeSha256='a'.repeat(64);record.gates.G03.evidenceFiles=['../../outside'];assert.equal((await validateAcceptance(options)).ready,false);record.gates.G03.evidenceFiles=['docs/validation/missing.json'];assert.equal((await validateAcceptance(options)).ready,false);
}));
test('正式验收保留全部门槛，缺少用户、72 小时、7 日或发布签名任一项均失败',()=>fixture(async root=>{
  for(const change of [g=>g.G01.newUsers=4,g=>g.G01.successfulNewUsers=3,g=>g.G04.mixedLoadHours=71,g=>g.G04.realUseDays=6,g=>g.G04.memoryGrowthPercent=16,g=>g.G05.nativePublisherVerified=false,g=>g.G05.manifestPublisherVerified=false,g=>g.G06.status='pending']){const record=accepted();change(record.gates);assert.equal((await validateAcceptance({root,record,codeInputTreeSha256:'a'.repeat(64)})).ready,false);}
}));
