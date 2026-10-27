import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, readFile, writeFile, mkdir, lstat, rename, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, delimiter } from 'node:path';
import { parseEnv } from 'node:util';
import { componentCatalog, componentState, installedComponent, previousComponentDirectory, specHash, programRoot } from '../component-paths.mjs';
import { extractZip, obtainArchive, sha256 } from './archive.mjs';
import { verifyAcp } from './acp-probe.mjs';

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('组件文件路径越界');
}
async function directory(path) {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('组件管理目录不能使用链接或普通文件');
}
async function removeOwned(root, path) {
  inside(root, resolve(path));
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isSymbolicLink()) inside(await realpath(root), await realpath(path));
  await rm(path, { recursive: !info.isSymbolicLink(), force: true, maxRetries: 5, retryDelay: 100 });
}

export function childEnvironment(node, temporary) {
  const env = {};
  for (const [key,value] of Object.entries(process.env)) if (/^(SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) env[key] = value;
  env.PATH = dirname(node) + delimiter + (process.env.PATH || process.env.Path || '');
  env.DSH_HOME = join(temporary, 'dsh-home');
  env.NPM_CONFIG_USERCONFIG = join(temporary, 'user.npmrc');
  env.NPM_CONFIG_GLOBALCONFIG = join(temporary, 'global.npmrc');
  env.NPM_CONFIG_CACHE = join(temporary, 'npm-cache');
  return env;
}
export async function runChild(command, args, { cwd, env, signal, timeout = 600000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', failure;
    const timer = setTimeout(() => { failure = new Error('组件准备超时，请重试'); child.kill(); }, timeout);
    const collect = b => { output = (output + b.toString()).slice(-16000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { failure = error; if (!child.pid) { clearTimeout(timer); reject(error); } });
    child.once('close', code => { clearTimeout(timer); failure ? reject(failure) : code === 0 ? done(output) : reject(new Error(`组件子进程失败（退出码 ${code}），请检查网络后重试`)); });
  });
}

export async function listComponents({ root = programRoot, dataRoot, platform = process.platform, arch = process.arch } = {}) {
  const catalog = await componentCatalog(root);
  return Promise.all(Object.entries(catalog.components).filter(([id]) => id !== 'node').map(async ([id,spec]) => {
    const installed = await installedComponent(id, dataRoot, root);
    return { id, name: spec.name, version: spec.version, installed: Boolean(installed), supported: `${platform}-${arch}` === catalog.platform, directory: installed?.directory || '', source: spec.source };
  }));
}

/** 每次准备独立版本目录，全部校验和探测通过后才替换活动记录。 */
export async function prepareComponent({ id, archivePath, root = programRoot, dataRoot, signal, onProgress = () => {}, fetcher, platform = process.platform, arch = process.arch, probe, catalog: suppliedCatalog } = {}) {
  const catalog = suppliedCatalog || await componentCatalog(root);
  if (`${platform}-${arch}` !== catalog.platform || !Object.hasOwn(catalog.components, id)) throw new Error('此组件仅支持 Windows x64，或组件名称无效');
  if (archivePath && catalog.components[id].kind !== 'zip') throw new Error('此组件不支持 ZIP 导入，请使用固定依赖清单准备');
  const base = resolve(dataRoot, 'components'); await directory(base);
  const { acquireDataResources } = await import('../../dist/core/resource-lock.js');
  const { dataPaths, mutableDataResources } = await import('../../dist/core/data-paths.js');
  const text = await readFile(join(dataRoot,'.env'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  const env = { ...process.env, ...parseEnv(text) };
  const lease = await acquireDataResources([...mutableDataResources(dataPaths(env, dataRoot)), {path:base,label:'组件安装'}], signal);
  try {
    const previous = await previousComponentDirectory(id, dataRoot, root);
    await directory(join(base,'.staging'));
    const install = async (component, localArchive) => {
      const spec = catalog.components[component];
      let node;
      if (spec.kind === 'npm') {
        node = await installedComponent('node', dataRoot, root);
        if (!node) { await install('node'); node = await installedComponent('node', dataRoot, root); }
      }
      signal?.throwIfAborted();
      const token = `${spec.version}-${randomBytes(6).toString('hex')}`;
      const stage = join(base,'.staging',`${component}-${token}`);
      const payload = join(stage,'payload');
      const parent = join(base, component); await directory(parent);
      const target = join(parent, token);
      await mkdir(stage);
      let published = false, moved = false;
      const progress = (phase, extra = {}) => onProgress({ id:component, phase, ...extra });
      try {
        if (spec.kind === 'zip') {
          let bundled = false;
          if (component === 'node' && !localArchive && spec.executableSha256) {
            try {
              const release = JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'));
              bundled = release.nodeArchiveSha256 === spec.sha256 && await sha256(join(root,'runtime/node.exe')) === spec.executableSha256;
            } catch(error) { if(error.code!=='ENOENT')throw error; }
          }
          if (bundled) {
            progress('copying');
            await cp(join(root,'runtime'),payload,{recursive:true,filter:async path=>{signal?.throwIfAborted();if((await lstat(path)).isSymbolicLink())throw new Error('内置运行环境包含不受支持的链接');return true;}});
          } else {
            const archive = join(stage,'archive.zip');
            progress('downloading', { received:0, total:spec.size });
            await obtainArchive(spec, archive, { signal, archivePath:localArchive, fetcher, onProgress:event=>progress('downloading',event) });
            progress('extracting'); await extractZip(archive, payload, { prefix:spec.prefix, signal });
          }
        } else if (spec.kind === 'npm') {
          await mkdir(payload);
          const lock = join(root,'components/dsh/package-lock.json');
          if (await sha256(lock) !== spec.lockSha256) throw new Error('DSH 依赖清单摘要不匹配，已拒绝安装');
          const lockText = await readFile(lock,'utf8'), parsed = JSON.parse(lockText);
          for (const [path,pkg] of Object.entries(parsed.packages)) if (path && (!pkg.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity || '') || pkg.link)) throw new Error('DSH 清单包含非官方包或未固定摘要的依赖');
          await writeFile(join(payload,'package.json'), await readFile(join(root,'components/dsh/package.json')));
          await writeFile(join(payload,'package-lock.json'), lockText);
          await writeFile(join(stage,'user.npmrc'),''); await writeFile(join(stage,'global.npmrc'),'');
          const executable = join(node.directory,'node.exe');
          progress('installing');
          await runChild(executable,[join(node.directory,'node_modules/npm/bin/npm-cli.js'),'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],{cwd:payload,env:childEnvironment(executable,stage),signal});
          const nodeRelative = relative(target, executable);
          const nodePath = isAbsolute(nodeRelative) ? nodeRelative : `%~dp0${nodeRelative}`;
          await writeFile(join(payload,'dsh.cmd'),`@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${nodePath}" "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\nexit /b %errorlevel%\r\n`);
        } else throw new Error('组件获取方式无效');
        if (component === 'napcat' && spec.licenseSha256) {
          const license = join(root,'components/licenses/NapCat.txt');
          if (await sha256(license) !== spec.licenseSha256) throw new Error('QQ 组件许可声明校验失败');
          await writeFile(join(payload,'NAPCAT-LICENSE.txt'),await readFile(license));
        }
        signal?.throwIfAborted(); progress('checking');
        const files = {};
        for (const name of spec.required) {
          const path = resolve(payload,name); inside(payload,path);
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error(`组件缺少普通入口文件：${name}`);
          files[name] = await sha256(path);
        }
        if (probe) await probe(component, payload, signal);
        else if (component === 'node') {
          const version = await runChild(join(payload,'node.exe'),['--version'],{cwd:stage,signal,timeout:15000});
          if (version.trim() !== `v${spec.version}`) throw new Error('Node 运行版本与清单不一致');
        } else if (component === 'dsh') {
          const version = await runChild(join(node.directory,'node.exe'),[join(payload,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--version'],{cwd:stage,env:childEnvironment(join(node.directory,'node.exe'),stage),signal,timeout:15000});
          if (!version.includes(spec.version)) throw new Error('DSH 运行版本与清单不一致');
          await verifyAcp({node:join(node.directory,'node.exe'),entry:join(payload,'node_modules/@deepseek-ai/dsh/lib/bin.js'),cwd:stage,env:childEnvironment(join(node.directory,'node.exe'),stage),signal});
          await runChild(join(node.directory,'node.exe'),[join(root,'scripts/components/mcp-probe.mjs'),payload,root],{cwd:stage,env:childEnvironment(join(node.directory,'node.exe'),stage),signal,timeout:20000});
        } else if (component === 'napcat') {
          const version = await runChild(join(payload,'node.exe'),['--version'],{cwd:stage,env:childEnvironment(join(payload,'node.exe'),stage),signal,timeout:15000});
          if (version.trim() !== `v${spec.nodeVersion}`) throw new Error('QQ 组件的独立运行环境版本不符');
        }
        signal?.throwIfAborted();
        await writeFile(join(payload,'installation.json'),JSON.stringify({specHash:specHash(spec),files,installedAt:new Date().toISOString()},null,2)+'\n');
        await rename(payload,target); moved = true;
        signal?.throwIfAborted();
        const next = { ...await componentState(dataRoot), [component]:token };
        await writeFile(join(stage,'active.json'),JSON.stringify(next,null,2)+'\n');
        await rename(join(stage,'active.json'),join(base,'active.json')); published = true;
        progress('ready');
        return {id:component,directory:target};
      } finally {
        if (moved && !published) await removeOwned(base,target);
        await removeOwned(base,stage);
      }
    };
    const installed = await install(id, archivePath);
    const suggestions = id === 'dsh' ? [{key:'BOT_DSH_BIN',value:join(installed.directory,'dsh.cmd'),previous:previous?join(previous,'dsh.cmd'):''},...(!previous?[{key:'BOT_DSH_HOME',value:join(dataRoot,'dsh')}]:[])] : id === 'napcat' ? [{key:'BOT_NAPCAT_DIR',value:join(installed.directory,'napcat'),previous:previous?join(previous,'napcat'):''}] : [];
    return { installed, suggestions, rows:await listComponents({root,dataRoot,platform,arch}) };
  } finally { lease.release(); }
}
