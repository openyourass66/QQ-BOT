import {cp,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve,relative,dirname,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {componentCatalog} from './component-paths.mjs';
import {obtainArchive,extractTarGz,sha256} from './components/archive.mjs';
import {childEnvironment,runChild} from './components/manager.mjs';
import {validateRelease,releaseRequiredLinux,releaseScriptsLinux} from './release-validation.mjs';
import {signReleasePackage} from './release-integrity.mjs';
import {copyCompiledInputs} from './release-inputs.mjs';
import {releaseInputTree,validateAcceptance} from './check-release-gates.mjs';

/**
 * Linux x64 服务器发行目录：固定官方 Node、编译产物、Linux 运行脚本与生产依赖，
 * 执行模块核对和启动路径检查，然后按与 Windows 相同的签名清单签发。
 */
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{output:{type:'string'},'node-archive':{type:'string'},zip:{type:'boolean',default:false},'signing-key':{type:'string'},'key-id':{type:'string'},'trust-file':{type:'string'},channel:{type:'string',default:'internal-validation'},'allow-dirty':{type:'boolean',default:false}}});
if(!['internal-validation','stable'].includes(values.channel))throw new Error('发行通道无效');
const signed=Boolean(values['signing-key']);if(['signing-key','key-id','trust-file'].some(key=>Boolean(values[key])!==signed)||values.channel==='stable'&&!signed)throw new Error('签名发行须同时提供私钥文件、公钥编号和信任清单；稳定通道不接受未签名输入');
if(values.channel==='stable'){
  if(values['allow-dirty'])throw new Error('稳定通道不能使用未提交的工作区构建');
  if(resolve(values['trust-file']).toLowerCase()!==join(root,'components/release-trust.json').toLowerCase())throw new Error('正式发行必须使用已经提交的发布公钥清单');
  const record=JSON.parse(await readFile(join(root,'docs/validation/release-acceptance.json'),'utf8')),acceptance=await validateAcceptance({root,record,codeInputTreeSha256:releaseInputTree(root)});if(!acceptance.ready)throw new Error('G01–G06 实际验收尚未齐全，继续内部验证，不能生成稳定发行');
}
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('Linux 发行目录构建仅支持 Linux x64');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
if(revision.status!==0||!/^[a-f0-9]{40,64}$/.test(revision.stdout.trim()))throw new Error('发行包须从可识别的 Git 提交构建，请在完整源码工作区运行');
const sourceRevision=revision.stdout.trim(),inputs=['src','scripts','desktop','templates','components','package.json','package-lock.json','tsconfig.json','.env.example','LICENSE'];
const changes=spawnSync('git',['status','--porcelain','--untracked-files=normal','--',...inputs],{cwd:root,encoding:'utf8'});
if(changes.status!==0)throw new Error('无法检查工作区状态');
if(changes.stdout.trim()&&!values['allow-dirty'])throw new Error('发行输入仍有未提交改动；内部验证可显式使用 --allow-dirty，稳定通道不接受');
const release=join(root,'release');await mkdir(release,{recursive:true});
if((await lstat(release)).isSymbolicLink())throw new Error('发行输出目录不能使用目录链接');
const output=resolve(root,values.output||`release/WhaleWorkbench-${pkg.version}-linux-x64`);
const rel=relative(release,output);
if(!rel||rel.startsWith('..')||isAbsolute(rel)||dirname(output)!==release)throw new Error('输出必须是本项目 release 下的直接子目录，不接受嵌套目录或目录链接');
for(const target of values.zip?[output,output+'.tar.gz',output+'.tar.gz.sha256']:[output])if(await lstat(target).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;}))throw new Error('输出已存在，请选择新的 --output，不会覆盖已有发行包或摘要');
const stage=await mkdtemp(join(release,'.package-linux-')),app=join(stage,'app');
try{
  await mkdir(app);
  console.log('准备固定版本 Node 运行环境…');
  const spec=(await componentCatalog(root,'linux','x64')).components.node;
  if(spec.kind!=='tar.gz')throw new Error('Node 组件必须是 tar.gz');
  await mkdir(join(root,'release/cache'),{recursive:true});
  const cached=values['node-archive']?resolve(values['node-archive']):join(root,`release/cache/node-v${spec.version}-linux-x64.tar.gz`);
  const local=await stat(cached).then(()=>cached,()=>undefined);
  if(values['node-archive']&&!local)throw new Error('指定的 Node 组件包不存在');
  if(local){if(await sha256(cached)!==spec.sha256)throw new Error('本地 Node 组件包摘要与清单不一致，请删除后重新准备');}
  else await obtainArchive(spec,cached);
  await extractTarGz(cached,join(app,'runtime'),{prefix:spec.prefix});
  console.log('复制编译产物、运行脚本与公开模板…');
  await copyCompiledInputs(root,app);
  await copyTree(join(root,'templates'),join(app,'templates'),()=>true);
  await copyTree(join(root,'components'),join(app,'components'),()=>true);
  await copyTree(join(root,'desktop'),join(app,'desktop'),name=>name.startsWith('assets/')||/\.(?:mjs|xaml|json)$/.test(name));
  await mkdir(join(app,'scripts'),{recursive:true});
  for(const file of releaseScriptsLinux)await cp(join(root,'scripts',file),join(app,'scripts',file),{force:false,errorOnExist:true});
  await copyTree(join(root,'scripts/components'),join(app,'scripts/components'),name=>name.endsWith('.mjs'));
  await mkdir(join(app,'packaging/systemd'),{recursive:true});
  await cp(join(root,'packaging/systemd/whaled.service'),join(app,'packaging/systemd/whaled.service'),{force:false,errorOnExist:true});
  for(const name of ['package.json','package-lock.json','.env.example','LICENSE'])await cp(join(root,name),join(app,name),{force:false,errorOnExist:true});
  if(signed)await cp(resolve(values['trust-file']),join(app,'components/release-trust.json'));
  const manifest={formatVersion:1,appId:'whale-workbench',version:pkg.version,platform:'linux-x64',channel:values.channel,sourceRevision,builtAt:new Date().toISOString(),node:spec.version,nodeArchiveSha256:spec.sha256,componentsCatalogSha256:await sha256(join(root,'components/catalog.linux-x64.json'))};
  await writeFile(join(app,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(stage,'user.npmrc'),'');await writeFile(join(stage,'global.npmrc'),'');
  console.log('按锁定清单安装生产依赖…');
  const node=join(app,'runtime/bin/node');
  await runChild(node,[join(app,'runtime/lib/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],{cwd:app,env:childEnvironment(node,stage)});
  const runtimePackage={...pkg,scripts:{}};delete runtimePackage.devDependencies;
  await writeFile(join(app,'package.json'),JSON.stringify(runtimePackage,null,2)+'\n');
  const lock=JSON.parse(await readFile(join(app,'package-lock.json'),'utf8'));
  for(const entry of Object.values(lock.packages))if(entry.resolved?.startsWith('https://registry.npmmirror.com/'))entry.resolved=entry.resolved.replace('https://registry.npmmirror.com/','https://registry.npmjs.org/');
  delete lock.packages[''].devDependencies;
  await writeFile(join(app,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
  await mkdir(join(app,'licenses'));
  await cp(join(app,'runtime/LICENSE'),join(app,'licenses/Node-LICENSE.txt'));
  const inventory=[];
  for(const [path,entry] of Object.entries(lock.packages))if(path&&!entry.dev&&await stat(join(app,path)).then(()=>true,()=>false))inventory.push({package:path,version:entry.version,license:entry.license||'请查阅包内许可文件'});
  await writeFile(join(app,'licenses/dependencies.json'),JSON.stringify(inventory,null,2)+'\n');
  await rm(join(app,'node_modules/.bin'),{recursive:true,force:true});
  await materializeLinks(app);
  await independentFiles(app);
  console.log('验证内置环境与核心依赖…');
  const check=await runChild(node,['--input-type=module','-e',"import 'ws';import 'yauzl';import '@agentclientprotocol/sdk';import '@modelcontextprotocol/sdk/server/mcp.js';console.log(process.version)"],{cwd:app,env:childEnvironment(node,stage),timeout:15000});
  if(!check.includes(`v${spec.version}`))throw new Error('发行环境验证失败');
  const validation=await validateRelease(app,{required:releaseRequiredLinux});console.log(`发行模块核对通过：${validation.modules} 个模块，${validation.relativeImports} 项本地引用，${validation.packageImports} 项生产依赖引用`);
  const startup=await runChild(node,[join(app,'scripts/app-paths.mjs'),'--data-dir',join(stage,'validation-data')],{cwd:app,env:childEnvironment(node,stage),timeout:15000});
  if(JSON.parse(startup).programRoot!==app)throw new Error('发行目录启动路径校验失败');
  if(signed){console.log('签发并复核发行文件完整性清单…');await signReleasePackage({packageRoot:app,privateKeyFile:resolve(values['signing-key']),keyId:values['key-id'],trustFile:resolve(values['trust-file'])});}
  await rename(app,output);
  console.log(`内部验证目录已生成：${output}`);
  if(values.zip){await runChild('tar',['-czf',output+'.tar.gz','-C',release,basename(output)],{cwd:release});await writeFile(output+'.tar.gz.sha256',await sha256(output+'.tar.gz')+'  '+basename(output)+'.tar.gz\n');console.log(`内部验证包及摘要已生成：${output}.tar.gz`);}
}finally{
  const check=relative(release,resolve(stage));if(!check||check.startsWith('..')||isAbsolute(check))throw new Error('构建清理路径异常');
  await rm(stage,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}

async function copyTree(source,target,filter,prefix=''){
  for(const entry of await readdir(join(source,prefix),{withFileTypes:true})){
    const name=prefix?prefix+'/'+entry.name:entry.name,from=join(source,name),to=join(target,name),info=await lstat(from);
    if(info.isSymbolicLink())throw new Error('发行输入不接受链接：'+name);
    if(info.isDirectory()){await copyTree(source,target,filter,name);continue;}
    if(!info.isFile()||!filter(name))continue;
    await mkdir(dirname(to),{recursive:true});await cp(from,to,{force:false,errorOnExist:true});
  }
}

async function links(root,directory=''){
  const found=[];
  for(const entry of await readdir(join(root,directory),{withFileTypes:true})){
    const name=directory?directory+'/'+entry.name:entry.name,path=join(root,name),info=await lstat(path);
    if(info.isSymbolicLink())found.push(name);
    else if(info.isDirectory())found.push(...await links(root,name));
  }
  return found;
}

async function materializeLinks(root){
  for(const name of await links(root)){
    const path=join(root,name),target=await realpath(path),inside=relative(root,target),info=await lstat(target);
    if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('发行目录链接指向程序目录之外：'+name);
    if(!info.isFile())throw new Error('发行目录包含目录链接：'+name);
    await rm(path);await cp(target,path,{force:false,errorOnExist:true});
  }
}

async function* files(root,directory=''){
  for(const entry of await readdir(join(root,directory),{withFileTypes:true})){
    const name=directory?directory+'/'+entry.name:entry.name,path=join(root,name),info=await lstat(path);
    if(info.isDirectory())yield* files(root,name);else if(info.isFile())yield {name,path,info};
  }
}

async function independentFiles(root){
  for await(const {name,path,info} of files(root)){
    if(info.nlink===1)continue;
    const temporary=path+'.nlink-'+process.pid;await cp(path,temporary,{force:false,errorOnExist:true});await rename(temporary,path);
  }
}
