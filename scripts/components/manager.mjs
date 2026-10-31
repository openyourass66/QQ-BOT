import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, readFile, writeFile, mkdir, lstat, rename, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, delimiter } from 'node:path';
import { parseEnv } from 'node:util';
import { componentCatalog, componentState, installedComponent, napcatShellDirectory, previousComponentDirectory, specHash, programRoot } from '../component-paths.mjs';
import { extractAppImage, extractTarGz, extractZip, obtainArchive, sha256 } from './archive.mjs';
import { verifyAcp } from './acp-probe.mjs';
import { restrictedToolPatches } from '../../dist/agent/chat-model.js';

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

const nodeExecutable = (directory, platform) => join(directory, platform === 'win32' ? 'node.exe' : 'bin/node');
const npmCli = (directory, platform) => join(directory, platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');

export function childEnvironment(node, temporary, platform = process.platform) {
  const env = {};
  const names = platform === 'win32'
    ? /^(SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i
    : /^(HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|LANGUAGE|TERM|USER|LOGNAME|SHELL|DISPLAY|XDG_CONFIG_HOME|XDG_CACHE_HOME|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;
  for (const [key,value] of Object.entries(process.env)) if (names.test(key)) env[key] = value;
  env.PATH = dirname(node) + delimiter + (process.env.PATH || process.env.Path || (platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin'));
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
  const catalog = await componentCatalog(root, platform, arch);
  return Promise.all(Object.entries(catalog.components).filter(([id]) => id !== 'node').map(async ([id,spec]) => {
    const installed = await installedComponent(id, dataRoot, root, platform, arch);
    return { id, name: spec.name, version: spec.version, installed: Boolean(installed), supported: `${platform}-${arch}` === catalog.platform, directory: installed?.directory || '', source: spec.source };
  }));
}

/** 每次准备独立版本目录，全部校验和探测通过后才替换活动记录。 */
export async function prepareComponent({ id, archivePath, root = programRoot, dataRoot, signal, onProgress = () => {}, fetcher, platform = process.platform, arch = process.arch, probe, catalog: suppliedCatalog } = {}) {
  const catalog = suppliedCatalog || await componentCatalog(root, platform, arch);
  const targetPlatform = platform.includes('-') ? platform : `${platform}-${arch}`;
  if (targetPlatform !== catalog.platform || !Object.hasOwn(catalog.components, id)) throw new Error(`此组件仅支持 ${catalog.platform}，或组件名称无效`);
  if (archivePath && !['zip', 'appimage'].includes(catalog.components[id].kind)) throw new Error('此组件不支持本地包导入，请使用固定依赖清单准备');
  const base = resolve(dataRoot, 'components'); await directory(base);
  const { acquireDataResources } = await import('../../dist/core/resource-lock.js');
  const { dataPaths, mutableDataResources } = await import('../../dist/core/data-paths.js');
  const text = await readFile(join(dataRoot,'.env'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  const env = { ...process.env, ...parseEnv(text) };
  const lease = await acquireDataResources([...mutableDataResources(dataPaths(env, dataRoot)), {path:base,label:'组件安装'}], signal);
  try {
    const previous = await previousComponentDirectory(id, dataRoot, root, platform, arch);
    await directory(join(base,'.staging'));
    const install = async (component, localArchive) => {
      const spec = catalog.components[component];
      let node;
      if (spec.kind === 'npm') {
        node = await installedComponent('node', dataRoot, root, platform, arch);
        if (!node) { await install('node'); node = await installedComponent('node', dataRoot, root, platform, arch); }
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
        } else if (spec.kind === 'tar.gz') {
          const archive = join(stage,'archive.tar.gz');
          progress('downloading', { received:0, total:spec.size });
          await obtainArchive(spec, archive, { signal, archivePath:localArchive, fetcher, onProgress:event=>progress('downloading',event) });
          progress('extracting'); await extractTarGz(archive, payload, { prefix:spec.prefix, signal });
        } else if (spec.kind === 'appimage') {
          const archive = join(stage,'component.appimage');
          progress('downloading', { received:0, total:spec.size });
          await obtainArchive(spec, archive, { signal, archivePath:localArchive, fetcher, onProgress:event=>progress('downloading',event) });
          progress('extracting'); await extractAppImage(archive, stage, payload, { signal });
        } else if (spec.kind === 'npm') {
          await mkdir(payload);
          const lock = join(root,'components/dsh/package-lock.json');
          if (await sha256(lock) !== spec.lockSha256) throw new Error('DSH 依赖清单摘要不匹配，已拒绝安装');
          const lockText = await readFile(lock,'utf8'), parsed = JSON.parse(lockText);
          for (const [path,pkg] of Object.entries(parsed.packages)) if (path && (!pkg.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity || '') || pkg.link)) throw new Error('DSH 清单包含非官方包或未固定摘要的依赖');
          await writeFile(join(payload,'package.json'), await readFile(join(root,'components/dsh/package.json')));
          await writeFile(join(payload,'package-lock.json'), lockText);
          await writeFile(join(stage,'user.npmrc'),''); await writeFile(join(stage,'global.npmrc'),'');
          const executable = nodeExecutable(node.directory, platform);
          progress('installing');
          await runChild(executable,[npmCli(node.directory, platform),'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],{cwd:payload,env:childEnvironment(executable,stage,platform),signal});
          const nodeRelative = relative(target, executable);
          if (platform === 'win32') {
            const nodePath = isAbsolute(nodeRelative) ? nodeRelative : `%~dp0${nodeRelative}`;
            await writeFile(join(payload,'dsh.cmd'),`@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${nodePath}" "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\nexit /b %errorlevel%\r\n`);
          } else {
            if (isAbsolute(nodeRelative)) throw new Error('组件目录结构不受支持');
            await writeFile(join(payload,'dsh'),`#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$DIR/${nodeRelative.split('\\').join('/')}" "$DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n`,{mode:0o755});
          }
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
          const version = await runChild(nodeExecutable(payload, platform),['--version'],{cwd:stage,signal,timeout:15000});
          if (version.trim() !== `v${spec.version}`) throw new Error('Node 运行版本与清单不一致');
        } else if (component === 'dsh') {
          const executable = nodeExecutable(node.directory, platform), environment = childEnvironment(executable, stage, platform);
          const version = await runChild(executable,[join(payload,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--version'],{cwd:stage,env:environment,signal,timeout:15000});
          if (!version.includes(spec.version)) throw new Error('DSH 运行版本与清单不一致');
          const policyPatch=join(stage,'tool-policy.json');await writeFile(policyPatch,JSON.stringify(restrictedToolPatches()));
          await verifyAcp({node:executable,entry:join(payload,'node_modules/@deepseek-ai/dsh/lib/bin.js'),cwd:stage,env:environment,signal,patch:policyPatch,lifecycle:true});
          await runChild(executable,[join(root,'scripts/components/mcp-probe.mjs'),payload,root],{cwd:stage,env:environment,signal,timeout:20000});
          await runChild(executable,[join(root,'scripts/components/tool-policy-probe.mjs'),payload,root],{cwd:stage,env:environment,signal,timeout:20000});
          await runChild(executable,[join(root,'scripts/components/model-budget-probe.mjs'),payload,root],{cwd:stage,env:environment,signal,timeout:20000});
        } else if (component === 'napcat') {
          if (platform === 'win32') {
            const version = await runChild(nodeExecutable(payload, platform),['--version'],{cwd:stage,env:childEnvironment(nodeExecutable(payload, platform),stage,platform),signal,timeout:15000});
            if (version.trim() !== `v${spec.nodeVersion}`) throw new Error('QQ 组件的独立运行环境版本不符');
          } else {
            const info = await lstat(join(payload,'AppRun'));
            if ((info.mode & 0o111) === 0) throw new Error('QQ 组件入口不可执行');
          }
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
    const dshBin = platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const suggestions = id === 'dsh' ? [{key:'BOT_DSH_BIN',value:join(installed.directory,dshBin),previous:previous?join(previous,dshBin):''},...(!previous?[{key:'BOT_DSH_HOME',value:join(dataRoot,'dsh')}]:[])] : id === 'napcat' ? [{key:'BOT_NAPCAT_DIR',value:napcatShellDirectory(installed,platform),previous:previous?napcatShellDirectory({directory:previous},platform):''}] : [];
    return { installed, suggestions, rows:await listComponents({root,dataRoot,platform,arch}) };
  } finally { lease.release(); }
}
