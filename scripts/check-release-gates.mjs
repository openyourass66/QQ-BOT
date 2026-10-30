import {spawnSync} from 'node:child_process';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function releaseInputTree(root){const inputs=['src','scripts','desktop','templates','components','package.json','package-lock.json','tsconfig.json','.env.example','LICENSE'],result=spawnSync('git',['ls-tree','HEAD','--',...inputs],{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0||!result.stdout.trim())throw Error('正式验收必须绑定可识别的 Git 代码输入树');return createHash('sha256').update(result.stdout.replaceAll('\r\n','\n')).digest('hex');}
export async function validateAcceptance({root,record,codeInputTreeSha256}){
  const missing=[],add=(ok,message)=>{if(!ok)missing.push(message);};root=resolve(root);
  add(record?.formatVersion===1&&record.appId==='whale-workbench','验收记录格式');add(/^[a-f0-9]{64}$/.test(codeInputTreeSha256)&&record?.codeInputTreeSha256===codeInputTreeSha256,'验收记录与当前代码输入树一致');
  for(const id of ['G01','G02','G03','G04','G05','G06']){
    const gate=record?.gates?.[id];add(gate?.status==='passed',id+' 已通过');const evidence=gate?.evidenceFiles;add(Array.isArray(evidence)&&evidence.length>0&&evidence.length<=20,id+' 证据文件');
    for(const file of Array.isArray(evidence)?evidence:[]){let ok=typeof file==='string'&&/^docs\/validation\/.+\.(?:json|md)$/.test(file)&&!file.split('/').includes('..')&&!/[\\\x00-\x1f]/.test(file)&&file!=='docs/validation/release-acceptance.json';if(ok){const path=resolve(root,file),rel=relative(root,path);ok=Boolean(rel)&&!isAbsolute(rel)&&!rel.startsWith('..');if(ok){try{let cursor=path;while(cursor!==root){if((await lstat(cursor)).isSymbolicLink())throw Error();cursor=dirname(cursor);}const state=await lstat(path);ok=state.isFile()&&state.nlink===1&&state.size>0&&state.size<=10*1024*1024;}catch{ok=false;}}}add(ok,id+' 证据路径有效');}
  }
  const g=record?.gates??{};add(g.G01?.windows10x64===true&&g.G01?.windows11x64===true&&Number.isSafeInteger(g.G01?.newUsers)&&g.G01.newUsers>=5&&Number.isSafeInteger(g.G01?.successfulNewUsers)&&g.G01.successfulNewUsers>=4,'干净 Windows 10/11 与五名新用户记录');
  add(g.G02?.negativePermissions===true&&g.G02?.nativeToolBoundary===true,'权限负向与原生工具边界');add(g.G03?.lockMigrationBackupRestoreUpgradeRollback===true,'锁、迁移、备份恢复及升级回退演练');
  add(g.G04?.performancePassed===true&&Number.isFinite(g.G04?.mixedLoadHours)&&g.G04.mixedLoadHours>=72&&Number.isFinite(g.G04?.realUseDays)&&g.G04.realUseDays>=7&&Number.isFinite(g.G04?.memoryGrowthPercent)&&g.G04.memoryGrowthPercent<=15,'完整性能、72 小时、7 日与内存观察');
  add(g.G05?.fixedDependencyCiPassed===true&&g.G05?.manifestPublisherVerified===true&&g.G05?.nativePublisherVerified===true&&g.G05?.licensesChecked===true&&typeof g.G05?.ciRunUrl==='string'&&/^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(g.G05.ciRunUrl),'实际 CI、两类发布签名与许可记录');add(g.G06?.maintenanceWalkthrough===true&&g.G06?.upgradeRepairDiagnosticsRetentionDocs===true,'普通用户维护与中文说明');
  return {ready:missing.length===0,codeInputTreeSha256,missing};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');try{const record=JSON.parse(await readFile(join(root,'docs/validation/release-acceptance.json'),'utf8')),result=await validateAcceptance({root,record,codeInputTreeSha256:releaseInputTree(root)});console.log(JSON.stringify(result,null,2));if(!result.ready)process.exitCode=1;}catch{console.error('正式验收记录无法核对，继续内部验证；未生成稳定发行。');process.exitCode=1;}
}
