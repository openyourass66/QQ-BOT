import { cp, mkdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enterRuntime, prepareRuntime } from './app-paths.mjs';
import { installedComponent } from './component-paths.mjs';
import { installQQProfileIsolation } from './qq-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layout = await prepareRuntime({ root });
enterRuntime(layout);
if (process.platform !== 'win32') throw new Error('此 NapCat Node 启动器仅支持 Windows');
const managed = await installedComponent('napcat',layout.dataRoot,root);
const selectedShell = resolve(layout.dataRoot,process.env.BOT_NAPCAT_DIR || 'napcat/shell');
const managedSelected = managed && selectedShell === join(managed.directory,'napcat');
if (managedSelected && resolve(process.execPath).toLowerCase() !== join(managed.directory,'node.exe').toLowerCase()) {
  // 命令行也使用组件自己的原生运行库，与桌面入口保持一致。
  await new Promise((done,reject) => {
    const child = spawn(join(managed.directory,'node.exe'),[fileURLToPath(import.meta.url)],{cwd:layout.dataRoot,env:process.env,stdio:'inherit',windowsHide:true});
    const stop = () => child.kill();
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    child.once('error',reject);
    child.once('close',code=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);process.exitCode=code??1;done();});
  });
} else if (managedSelected) {
  const runtime = layout.napcatRuntime;
  const profile = join(layout.dataRoot,'napcat/qq-profile');
  await mkdir(profile,{recursive:true,mode:0o700});
  installQQProfileIsolation(join(managed.directory,'wrapper.node'),profile);
  await mkdir(join(runtime,'config'),{recursive:true});
  try { await writeFile(join(runtime,'config/webui.json'),JSON.stringify({host:'127.0.0.1',port:6099,token:randomBytes(24).toString('hex')},null,2)+'\n',{flag:'wx'}); }
  catch(error){if(error.code!=='EEXIST')throw error;}
  Object.assign(process.env,{
    NAPCAT_WRAPPER_PATH:join(managed.directory,'wrapper.node'),
    NAPCAT_QQ_PACKAGE_INFO_PATH:join(managed.directory,'package.json'),
    NAPCAT_QQ_VERSION_CONFIG_PATH:join(managed.directory,'config.json'),
    NAPCAT_DISABLE_PIPE:'1',NAPCAT_DISABLE_MULTI_PROCESS:'1',NAPCAT_WORKDIR:runtime,
    NAPCAT_QUICK_ACCOUNT:/^\d+$/.test(process.env.BOT_SELF_ID||'')&&process.env.BOT_SELF_ID!=='0'?process.env.BOT_SELF_ID:'',
  });
  process.chdir(runtime);
  console.log('正在启动已准备的 QQ 独立运行组件；首次使用请按官方流程登录并配置 OneBot。');
  await import(pathToFileURL(join(selectedShell,'napcat.mjs')).href);
} else {
if (!process.env.BOT_QQ_DIR) throw new Error('请在 .env 中配置 BOT_QQ_DIR，指向 QQ.exe 所在目录');
const qqRoot = resolve(process.env.BOT_QQ_DIR);
const shell = resolve(layout.dataRoot, process.env.BOT_NAPCAT_DIR || 'napcat/shell');
const runtime = layout.napcatRuntime;
const json = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const versions = await json(join(qqRoot, 'versions/config.json'));
if (typeof versions.curVersion !== 'string' || !/^\d+\.\d+\.\d+-\d+$/.test(versions.curVersion)) throw new Error('QQ 当前版本配置无效');
const app = join(qqRoot, 'versions', versions.curVersion, 'resources/app');
try { await access(join(runtime, 'QQNT.dll')); }
catch { throw new Error('缺少 NapCat 官方 Node 运行适配库 napcat/node-runtime/QQNT.dll，请先部署运行环境'); }
await mkdir(join(runtime, 'win64'), { recursive: true });
await mkdir(join(runtime, 'config'), { recursive: true });
const libraries = ['avif_convert.dll', 'broadcast_ipc.dll', 'crypto.dll', 'ssl.dll', 'libglib-2.0-0.dll', 'libgobject-2.0-0.dll', 'libvips-42.dll', 'ncnn.dll', 'opencv.dll', 'package.json', 'QBar.dll', 'wrapper.node', 'LightQuic.dll', 'win64/SSOShareInfoHelper64.dll', 'win64/parent-ipc-core-x64.dll'];
for (const name of libraries) {
  const source = join(app, name), target = join(runtime, name);
  const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target).catch(() => null)]);
  if (!targetStat || targetStat.size !== sourceStat.size || sourceStat.mtimeMs > targetStat.mtimeMs) await cp(source, target);
}
await cp(join(qqRoot, 'versions/config.json'), join(runtime, 'config.json'));
// 首次部署复用已有账号配置；保留运行目录中后续修改的设置。
if (/^\d+$/.test(process.env.BOT_SELF_ID || '')) {
  for (const prefix of ['onebot11', 'napcat', 'napcat_protocol']) {
    const name = `${prefix}_${process.env.BOT_SELF_ID}.json`;
    try { await access(join(runtime, 'config', name)); }
    catch {
      try { await writeFile(join(runtime, 'config', name), JSON.stringify(await json(join(shell, 'config', name)), null, 2) + '\n'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
Object.assign(process.env, {
  NAPCAT_WRAPPER_PATH: join(runtime, 'wrapper.node'),
  NAPCAT_QQ_PACKAGE_INFO_PATH: join(runtime, 'package.json'),
  NAPCAT_QQ_VERSION_CONFIG_PATH: join(runtime, 'config.json'),
  NAPCAT_DISABLE_PIPE: '1', NAPCAT_DISABLE_MULTI_PROCESS: '1',
  NAPCAT_WORKDIR: runtime, NAPCAT_QUICK_ACCOUNT: process.env.BOT_SELF_ID || '',
});
// 部分原生组件按工作目录写数据库，统一放入被忽略的运行目录。
process.chdir(runtime);
console.log('正在启动 NapCat 独立 Node 运行环境');
await import(pathToFileURL(join(shell, 'napcat.mjs')).href);
}
