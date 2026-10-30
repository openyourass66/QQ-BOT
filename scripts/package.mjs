import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { componentCatalog } from './component-paths.mjs';
import { obtainArchive, extractZip, sha256 } from './components/archive.mjs';
import { childEnvironment, runChild } from './components/manager.mjs';
import {spawnSync} from 'node:child_process';
import {releaseScripts,validateRelease} from './release-validation.mjs';
import {signReleasePackage} from './release-integrity.mjs';
import {releaseInputTree,validateAcceptance} from './check-release-gates.mjs';
import {trackedPublicInputs,copyPublicInputs,copyCompiledInputs} from './release-inputs.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{output:{type:'string'},'node-archive':{type:'string'},zip:{type:'boolean',default:false},'signing-key':{type:'string'},'key-id':{type:'string'},'trust-file':{type:'string'},channel:{type:'string',default:'internal-validation'},'certificate-thumbprint':{type:'string'},'timestamp-server':{type:'string'}}});
if(!['internal-validation','stable'].includes(values.channel))throw new Error('发行通道无效');
const signed=Boolean(values['signing-key']);if(['signing-key','key-id','trust-file'].some(key=>Boolean(values[key])!==signed)||values.channel==='stable'&&!signed)throw new Error('签名发行须同时提供私钥文件、公钥编号和信任清单；稳定通道不接受未签名输入');
if(Boolean(values['certificate-thumbprint'])!==Boolean(values['timestamp-server'])||values.channel==='stable'&&!values['certificate-thumbprint'])throw new Error('正式稳定包还须配置发布者证书指纹及时间戳服务；两项须同时提供');
if(values.channel==='stable'){
  if(resolve(values['trust-file']).toLowerCase()!==join(root,'components/release-trust.json').toLowerCase())throw new Error('正式发行必须使用已经提交的发布公钥清单');
  const record=JSON.parse(await readFile(join(root,'docs/validation/release-acceptance.json'),'utf8')),acceptance=await validateAcceptance({root,record,codeInputTreeSha256:releaseInputTree(root)});if(!acceptance.ready)throw new Error('G01–G06 实际验收尚未齐全，继续内部验证，不能生成稳定发行');
}
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('发行目录构建仅支持 Windows x64');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,windowsHide:true,encoding:'utf8'});
if(revision.status!==0||!/^[a-f0-9]{40,64}$/.test(revision.stdout.trim()))throw new Error('发行包须从可识别的 Git 提交构建，请在完整源码工作区运行');
const sourceRevision=revision.stdout.trim(),inputs=['src','scripts','desktop','templates','components','package.json','package-lock.json','tsconfig.json','.env.example','LICENSE'];
const changes=spawnSync('git',['status','--porcelain','--untracked-files=normal','--',...inputs],{cwd:root,windowsHide:true,encoding:'utf8'});
if(changes.status!==0||changes.stdout.trim())throw new Error('发行输入仍有未提交改动，请先完成验证并建立代码检查点');
const release=join(root,'release');await mkdir(release,{recursive:true});
if((await lstat(release)).isSymbolicLink())throw new Error('发行输出目录不能使用目录链接');
const output=resolve(root,values.output||`release/WhaleWorkbench-${pkg.version}-win-x64`);
const rel=relative(release,output);
if(!rel||rel.startsWith('..')||isAbsolute(rel)||dirname(output).toLowerCase()!==release.toLowerCase())throw new Error('输出必须是本项目 release 下的直接子目录，不接受嵌套目录或目录链接');
for(const target of values.zip?[output,output+'.zip',output+'.zip.sha256']:[output])if(await lstat(target).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;}))throw new Error('输出已存在，请选择新的 --output，不会覆盖已有发行包或摘要');
const stage=await mkdtemp(join(release,'.package-'));
const app=join(stage,'app');await mkdir(app);
try {
  console.log('准备固定版本 Node 运行环境…');
  const spec=(await componentCatalog(root)).components.node;
  const archive=join(stage,'node.zip');
  const cached=values['node-archive']?resolve(values['node-archive']):join(root,`release/cache/node-v${spec.version}-win-x64.zip`);
  const local=await stat(cached).then(()=>cached,()=>undefined);
  if(values['node-archive']&&!local)throw new Error('指定的 Node 组件包不存在');
  await obtainArchive(spec,archive,{archivePath:local});
  await extractZip(archive,join(app,'runtime'),{prefix:spec.prefix});
  console.log('复制业务程序与公开模板…');
  await copyCompiledInputs(root,app);await copyPublicInputs(root,app,trackedPublicInputs(root));
  await cp(join(root,'QQ-BOT.exe'),join(app,'QQ-BOT.exe'));
  for(const file of ['WhaleSetup.exe','WhaleLauncher.exe'])await cp(join(root,file),join(app,file));
  if(signed){await cp(resolve(values['trust-file']),join(app,'components/release-trust.json'));await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'desktop/build-installer.ps1'),'-TrustFile',resolve(values['trust-file']),'-OutputDirectory',app],{cwd:root});}
  await cp(join(root,'desktop/runtime-guard.exe'),join(app,'desktop/runtime-guard.exe'));
  await cp(join(root,'desktop/media-cleaner.exe'),join(app,'desktop/media-cleaner.exe'));
  await mkdir(join(app,'scripts'),{recursive:true});
  for(const file of releaseScripts)await cp(join(root,'scripts',file),join(app,'scripts',file));
  const manifest={formatVersion:1,appId:'whale-workbench',version:pkg.version,channel:values.channel,sourceRevision,builtAt:new Date().toISOString(),node:spec.version,nodeArchiveSha256:spec.sha256,componentsCatalogSha256:await sha256(join(root,'components/catalog.json'))};
  await writeFile(join(app,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const runtimePackage={...pkg,scripts:{}};delete runtimePackage.devDependencies;
  await writeFile(join(app,'package.json'),JSON.stringify(runtimePackage,null,2)+'\n');
  const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  // 版本与 SRI 保持锁定，构建时统一从公开官方源获取。
  for(const entry of Object.values(lock.packages))if(entry.resolved?.startsWith('https://registry.npmmirror.com/'))entry.resolved=entry.resolved.replace('https://registry.npmmirror.com/','https://registry.npmjs.org/');
  delete lock.packages[''].devDependencies;
  await writeFile(join(app,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
  await writeFile(join(stage,'user.npmrc'),'');await writeFile(join(stage,'global.npmrc'),'');
  console.log('按锁定清单安装生产依赖…');
  const node=join(app,'runtime/node.exe');
  await runChild(node,[join(app,'runtime/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],{cwd:app,env:childEnvironment(node,stage)});
  await mkdir(join(app,'licenses'));
  await cp(join(app,'runtime/LICENSE'),join(app,'licenses/Node-LICENSE.txt'));
  const inventory=[];
  for(const [path,entry] of Object.entries(lock.packages))if(path&&!entry.dev&&await stat(join(app,path)).then(()=>true,()=>false))inventory.push({package:path,version:entry.version,license:entry.license||'请查阅包内许可文件'});
  await writeFile(join(app,'licenses/dependencies.json'),JSON.stringify(inventory,null,2)+'\n');
  await writeFile(join(app,'开始使用.cmd'),'@echo off\r\nsetlocal\r\nset "BOT_DATA_DIR="\r\nstart "" "%~dp0QQ-BOT.exe" --portable\r\n');
  await writeFile(join(app,'使用说明.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>小鲸工作台</title><style>body{max-width:800px;margin:48px auto;font:16px/1.8 system-ui;padding:0 24px}h1{font-size:28px}</style><h1>小鲸工作台 · 候选测试版</h1><p>把整个 ZIP 解压到可写目录，双击“开始使用.cmd”。程序会打开图形工作台，数据保存在本包旁的 user-data 目录，便于独立试用。无需安装 Node.js、npm、Git 或编译工具。</p><ol><li>打开快速配置，点击“准备运行组件”。首次准备 DSH 和 QQ 组件需要联网，等待完成后返回向导。</li><li>选择模型，填写自己的 API Key 并测试；模型测试会发送真实请求并消耗服务额度。</li><li>点击“配置并登录 QQ”，按提示扫码和确认，等待账号在线。</li><li>选择机器人主人及允许聊天的好友/群，检查并保存启动。</li><li>等待 QQ 在线、模型就绪后，在所选会话发消息验证。自主活动与空间能力默认关闭，可按需要配置开启。</li></ol><p>请保留整个程序目录。直接双击 QQ-BOT.exe 使用普通模式，数据保存到用户本地 WhaleWorkbench 目录；独立试用建议使用“开始使用.cmd”。密钥与登录状态由你在新实例提供，发行包不包含个人配置、聊天或登录资料。</p><p>本包用于个人非商业验证，尚未通过全部正式发布门槛；已提供停机加密备份与原实例恢复入口（连接与运行 → 存储与高级），备份不含 QQ / DSH 登录状态。完整安装升级回退、脱敏诊断、清理界面、干净系统及长时验收继续推进。项目代码采用 MIT，运行组件各自适用原许可。遇到缺组件、登录验证或网络问题时，按界面提示处理；关闭窗口会收起到托盘，退出请在托盘选择“退出并停止机器人”。</p><p>程序版本 '+pkg.version+'；代码检查点 '+sourceRevision.slice(0,12)+'。请勿把含 user-data 的运行目录当作干净发行包转发。</p></html>');
  console.log('验证内置环境与核心依赖…');
  const check=await runChild(node,['--input-type=module','-e',"import 'ws';import 'yauzl';import '@agentclientprotocol/sdk';import '@modelcontextprotocol/sdk/server/mcp.js';console.log(process.version)"],{cwd:app,env:childEnvironment(node,stage),timeout:15000});
  if(!check.includes(`v${spec.version}`))throw new Error('发行环境验证失败');
  const validation=await validateRelease(app);console.log(`发行模块核对通过：${validation.modules} 个模块，${validation.relativeImports} 项本地引用，${validation.packageImports} 项生产依赖引用`);
  const startup=await runChild(node,[join(app,'scripts/app-paths.mjs'),'--data-dir',join(stage,'validation-data')],{cwd:app,env:childEnvironment(node,stage),timeout:15000});
  if(JSON.parse(startup).programRoot.toLowerCase()!==app.toLowerCase())throw new Error('发行目录启动路径校验失败');
  if(values['certificate-thumbprint']){console.log('签署并核对原生程序发布者…');await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/sign-native.ps1'),'-Directory',app,'-Thumbprint',values['certificate-thumbprint'],'-TimestampServer',values['timestamp-server']],{cwd:root,timeout:180000});}
  if(signed){console.log('签发并复核发行文件完整性清单…');await signReleasePackage({packageRoot:app,privateKeyFile:resolve(values['signing-key']),keyId:values['key-id'],trustFile:resolve(values['trust-file'])});}
  await rename(app,output);
  console.log(`内部验证目录已生成：${output}`);
  if(values.zip){await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/zip-release.ps1'),'-Source',output,'-Destination',output+'.zip'],{cwd:root,env:childEnvironment(join(output,'runtime/node.exe'),stage)});await writeFile(output+'.zip.sha256',await sha256(output+'.zip')+'  '+output.split(/[\\/]/).at(-1)+'.zip\n');console.log(`内部验证包及摘要已生成：${output}.zip`);}
} finally {
  const check=relative(release,resolve(stage));if(!check||check.startsWith('..')||isAbsolute(check))throw new Error('构建清理路径异常');
  await rm(stage,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
