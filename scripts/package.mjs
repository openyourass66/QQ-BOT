import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { componentCatalog } from './component-paths.mjs';
import { obtainArchive, extractZip, sha256 } from './components/archive.mjs';
import { childEnvironment, runChild } from './components/manager.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{output:{type:'string'},'node-archive':{type:'string'},zip:{type:'boolean',default:false}}});
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('发行目录构建仅支持 Windows x64');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const release=join(root,'release');await mkdir(release,{recursive:true});
if((await lstat(release)).isSymbolicLink())throw new Error('发行输出目录不能使用目录链接');
const output=resolve(root,values.output||`release/WhaleWorkbench-${pkg.version}-win-x64`);
const rel=relative(release,output);
if(!rel||rel.startsWith('..')||isAbsolute(rel)||dirname(output).toLowerCase()!==release.toLowerCase())throw new Error('输出必须是本项目 release 下的直接子目录，不接受嵌套目录或目录链接');
for(const target of values.zip?[output,output+'.zip']:[output])if(await lstat(target).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;}))throw new Error('输出已存在，请选择新的 --output，不会覆盖已有发行包');
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
  for(const path of ['dist','templates','components','.env.example','LICENSE'])await cp(join(root,path),join(app,path),{recursive:true,filter:async source=>{const info=await lstat(source);if(info.isSymbolicLink())throw new Error('发行输入不接受目录链接');return !source.includes('node_modules');}});
  await cp(join(root,'QQ-BOT.exe'),join(app,'QQ-BOT.exe'));
  await mkdir(join(app,'desktop'));
  for(const file of await readdir(join(root,'desktop')))if(file.endsWith('.mjs')||file.endsWith('.xaml'))await cp(join(root,'desktop',file),join(app,'desktop',file));
  await cp(join(root,'desktop/assets'),join(app,'desktop/assets'),{recursive:true});
  await mkdir(join(app,'scripts'));
  for(const file of ['app-paths.mjs','setup.mjs','run.mjs','component-paths.mjs','components.mjs','napcat-node.mjs'])await cp(join(root,'scripts',file),join(app,'scripts',file));
  await cp(join(root,'scripts/components'),join(app,'scripts/components'),{recursive:true});
  const manifest={formatVersion:1,appId:'whale-workbench',version:pkg.version,channel:'internal-validation',node:spec.version,nodeArchiveSha256:spec.sha256,componentsCatalogSha256:await sha256(join(root,'components/catalog.json'))};
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
  await writeFile(join(app,'使用说明.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>小鲸工作台</title><style>body{max-width:800px;margin:48px auto;font:16px/1.8 system-ui;padding:0 24px}h1{font-size:28px}</style><h1>小鲸工作台 · 内部验证版</h1><p>双击 QQ-BOT.exe，无需安装 Node.js、npm 或编译工具。</p><ol><li>打开快速配置，点击“准备运行组件”。首次准备需要联网。</li><li>选择模型并填写自己的 API Key。</li><li>配置 QQ 接入并按官方流程完成登录。</li><li>检查配置，保存并启动。</li></ol><p>普通模式数据保存在用户本地的 WhaleWorkbench 目录。使用 --portable 可把数据保存在程序旁的 user-data 目录；更新程序前先停止机器人。</p><p>本包用于个人非商业验证。项目代码采用 MIT，下载的组件各自适用原许可。QQ 登录、完整迁移、自动恢复和持续运行验收尚未全部完成，请先使用测试账号与独立数据目录。</p><p>原始凭据和个人配置不会包含在本包内；模型调用会使用你自己的服务额度。</p></html>');
  console.log('验证内置环境与核心依赖…');
  const check=await runChild(node,['--input-type=module','-e',"import 'ws';import 'yauzl';import '@agentclientprotocol/sdk';import '@modelcontextprotocol/sdk/server/mcp.js';console.log(process.version)"],{cwd:app,env:childEnvironment(node,stage),timeout:15000});
  if(!check.includes(`v${spec.version}`))throw new Error('发行环境验证失败');
  await rename(app,output);
  console.log(`内部验证目录已生成：${output}`);
  if(values.zip){await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/zip-release.ps1'),'-Source',output,'-Destination',output+'.zip'],{cwd:root,env:childEnvironment(join(output,'runtime/node.exe'),stage)});console.log(`内部验证包已生成：${output}.zip`);}
} finally {
  const check=relative(release,resolve(stage));if(!check||check.startsWith('..')||isAbsolute(check))throw new Error('构建清理路径异常');
  await rm(stage,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
