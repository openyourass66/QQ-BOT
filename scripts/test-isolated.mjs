import { spawn, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (files.error || files.status !== 0) throw new Error('隔离测试需要在可读取的 Git 工作区运行');
const allowed = path => /^(?:src|tests|desktop|scripts|templates|docs|components)\//.test(path) || ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', '.env.example', '.gitignore'].includes(path);
const paths = [...new Set(files.stdout.split('\0').filter(path => path && allowed(path)))];
const tempRoot = await realpath(tmpdir());
const scratch = await mkdtemp(join(tempRoot, 'qq-bot-check-'));
let code = 1;
async function run(args) {
  return new Promise((done, reject) => {
    const env = { ...process.env };
    delete env.BOT_DATA_DIR;
    const child = spawn(process.execPath, args, { cwd: scratch, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (status, signal) => signal ? reject(new Error(`测试进程中断：${signal}`)) : done(status ?? 1));
  });
}
try {
  for (const path of paths) {
    const source = resolve(root, path);
    const destination = resolve(scratch, path);
    const rel = relative(scratch, destination);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('测试源码路径越界');
    if (!(await lstat(source)).isFile()) throw new Error(`隔离测试不复制非普通文件：${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`隔离测试目录：${scratch}`);
  code = await run(['scripts/build.mjs']);
  if (code === 0) {
    const tests = paths.filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
    code = await run(['--test', ...process.argv.slice(2), ...tests]);
  }
} finally {
  const actual = await realpath(scratch);
  const rel = relative(tempRoot, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(actual).startsWith('qq-bot-check-')) throw new Error('隔离目录位置异常，已保留供检查');
  // Remove the dependency link explicitly before recursively removing our temporary tree.
  await rm(join(scratch, 'node_modules'), { force: true, recursive: process.platform === 'win32' });
  await rm(actual, { recursive: true, force: true });
}
process.exitCode = code;
