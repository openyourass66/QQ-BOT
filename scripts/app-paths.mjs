import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { setup } from './setup.mjs';

export const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length).replace(/^[\\/]+/, ''));
  }
}

/** 按实际目录身份比较路径，兼容 Windows 短名称、目录联接和大小写。 */
export async function sameRuntimePath(left,right) {
  const [a,b]=await Promise.all([canonical(resolve(left)),canonical(resolve(right))]);
  return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

/** 只解析目录，不创建文件；供原生窗口、后台与命令行共用。 */
export async function runtimeLayout({ root = programRoot, sourceRoot = root, cwd = process.cwd(), env = process.env, args = [], platform = process.platform } = {}) {
  root = await canonical(resolve(root));
  let release = false;
  try {
    const text = await readFile(join(root, 'release-manifest.json'), 'utf8');
    if (Buffer.byteLength(text) > 16384) throw new Error('发行清单过大');
    const manifest = JSON.parse(text);
    if (manifest.formatVersion !== 1 || manifest.appId !== 'whale-workbench') throw new Error('发行清单版本不受支持');
    release = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('程序目录的发行清单无效，请重新解压完整程序。', { cause: error });
  }
  let selected, portable = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--portable') { if (portable) throw new Error('请勿重复指定 --portable'); portable = true; }
    else if (arg === '--data-dir') {
      if (selected !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--data-dir 需要一个数据目录，且只能指定一次。');
      selected = args[++i];
    } else throw new Error(`未知启动参数：${arg}`);
  }
  const custom = selected ?? env.BOT_DATA_DIR;
  if (custom !== undefined && !custom.trim()) throw new Error('数据目录不可为空。');
  if (portable && custom) throw new Error('--portable 与自定义数据目录不能同时使用。');
  let dataRoot;
  if (custom) dataRoot = resolve(cwd, custom);
  else if (portable) dataRoot = join(root, 'user-data');
  else if (!release) dataRoot = resolve(sourceRoot);
  else if (platform === 'win32') {
    if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) throw new Error('无法确定用户数据目录，请通过 --data-dir 指定可写目录。');
    dataRoot = join(env.LOCALAPPDATA, 'WhaleWorkbench');
  } else {
    const base = env.XDG_DATA_HOME || join(homedir(), '.local/share');
    if (!isAbsolute(base)) throw new Error('XDG_DATA_HOME 必须是绝对路径。');
    dataRoot = join(base, 'WhaleWorkbench');
  }
  dataRoot = await canonical(dataRoot);
  return { programRoot: root, dataRoot, mode: portable ? 'portable' : release ? 'installed' : 'source', customData: Boolean(custom), envFile: join(dataRoot, '.env'), logDir: join(dataRoot, 'data/desktop'), napcatRuntime: join(dataRoot, 'napcat/node-runtime') };
}

export async function prepareRuntime(options) {
  const layout = await runtimeLayout(options);
  try {
    await mkdir(layout.dataRoot, { recursive: true });
    const probe = join(layout.dataRoot, `.write-check-${process.pid}-${randomUUID()}`);
    const file = await open(probe, 'wx');
    try { await file.close(); } finally { await rm(probe); }
    if (existsSync(join(layout.programRoot, '.env.example')) && existsSync(join(layout.programRoot, 'templates/bot-persona.md'))) await setup(layout.programRoot, layout.dataRoot);
    else if (layout.mode !== 'source') throw new Error('程序缺少默认配置或人设模板，请重新解压完整程序。');
  } catch (error) {
    throw new Error(`无法初始化数据目录：${layout.dataRoot}。请检查访问权限或通过 --data-dir 选择可写目录。${error.message}`, { cause: error });
  }
  return layout;
}

export function enterRuntime(layout, { loadEnv = true } = {}) {
  process.chdir(layout.dataRoot);
  process.env.BOT_DATA_DIR = layout.dataRoot;
  if (loadEnv) {
    try { loadEnvFile(layout.envFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const prepare = args[0] === '--prepare';
  if (prepare) args.shift();
  try { process.stdout.write(JSON.stringify(await (prepare ? prepareRuntime : runtimeLayout)({ args }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
