import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = '/etc/systemd/system';

function usage() {
  return [
    '用法：sudo node scripts/whaled-install.mjs [选项]',
    '  --data-dir <路径>  机器人数据目录，默认 /var/lib/whaleworkbench',
    '  --user <账户>      运行服务的系统账户，默认 whaleworkbench',
    '  --node <路径>      固定 Node 可执行文件，默认程序目录的 runtime/bin/node',
    '  --program <路径>   程序目录，默认当前脚本所在目录',
    '  --service <名称>   systemd 单元名，默认 whaled.service',
    '  --no-start         只安装并设为开机启动，不立即启动',
    '  --dry-run          只打印将写入的单元与执行的命令',
  ].join('\n');
}

function run(command, argv) {
  return new Promise((done, reject) => {
    const child = spawn(command, argv, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? done() : reject(new Error(`${command} 退出代码 ${code}`)));
  });
}

function userExists(user) {
  return new Promise(done => {
    const child = spawn('id', ['-u', user], { stdio: 'ignore' });
    child.once('error', () => done(false));
    child.once('close', code => done(code === 0));
  });
}

async function main() {
  const values = { 'data-dir': '/var/lib/whaleworkbench', user: 'whaleworkbench', node: '', program: root, service: 'whaled.service', start: true, 'dry-run': false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-start') values.start = false;
    else if (arg === '--dry-run') values['dry-run'] = true;
    else if (['--data-dir', '--user', '--node', '--program', '--service'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个参数。\n${usage()}`);
      values[arg.slice(2)] = value;
    } else throw new Error(`未知参数：${arg}\n${usage()}`);
  }

  const safePath = value => value !== '/' && isAbsolute(value) && /^[\w@.+/-]+$/.test(value);
  if (!safePath(values['data-dir'])) throw new Error('数据目录必须是绝对路径，且只包含字母、数字、点、下划线、短横线和斜杠。');
  if (!safePath(values.program)) throw new Error('程序目录必须是绝对路径，且只包含字母、数字、点、下划线、短横线和斜杠。');
  if (!/^[a-z_][a-z0-9_-]*$/.test(values.user)) throw new Error('服务账户名只能包含小写字母、数字、下划线和短横线。');
  if (!/^[a-z][a-z0-9_-]{0,48}\.service$/.test(values.service)) throw new Error('systemd 单元名必须形如 whaled.service，只能包含小写字母、数字、下划线和短横线。');
  values.node = values.node || join(values.program, 'runtime/bin/node');
  if (!safePath(values.node)) throw new Error('Node 路径必须是绝对路径，且只包含字母、数字、点、下划线、短横线和斜杠。');
  if (process.platform === 'win32') throw new Error('本脚本用于 Linux 服务器；Windows 请直接使用桌面控制台。');

  const templatePath = join(root, 'packaging/systemd/whaled.service');
  if (!existsSync(templatePath)) throw new Error(`缺少 systemd 单元模板：${templatePath}。请使用完整发行包。`);
  const unit = (await readFile(templatePath, 'utf8'))
    .replaceAll('@USER@', values.user)
    .replaceAll('@DATA_DIR@', values['data-dir'])
    .replaceAll('@NODE@', values.node)
    .replaceAll('@PROGRAM@', values.program);
  const unitTarget = join(UNIT_DIR, values.service);

  if (values['dry-run']) {
    console.log(`# 将写入 ${unitTarget}`);
    console.log(unit);
    console.log(`# 将创建系统账户 ${values.user}（如不存在）、目录 ${values['data-dir']}，随后执行`);
    console.log('systemctl daemon-reload');
    console.log(`systemctl enable ${values.service}`);
    if (values.start) console.log(`systemctl restart ${values.service}`);
    return;
  }

  if (process.getuid?.() !== 0) throw new Error('安装守护进程需要 root 权限，请使用 sudo 运行。');

  if (!await userExists(values.user)) {
    console.log(`正在创建系统账户 ${values.user}…`);
    await run('useradd', ['--system', '--user-group', '--home-dir', values['data-dir'], '--shell', '/usr/sbin/nologin', values.user]);
  }
  await mkdir(join(values['data-dir'], 'home'), { recursive: true, mode: 0o700 });
  await chmod(values['data-dir'], 0o700);
  await run('chown', ['-R', `${values.user}:${values.user}`, values['data-dir']]);
  await writeFile(unitTarget, unit, { mode: 0o644 });
  console.log(`已写入 ${unitTarget}`);
  await run('systemctl', ['daemon-reload']);
  await run('systemctl', ['enable', values.service]);
  if (values.start) await run('systemctl', ['restart', values.service]);
  console.log(values.start
    ? `守护进程已启动。查看状态：systemctl status ${values.service}；日志：journalctl -u ${values.service} -f`
    : `守护进程已设为开机启动。启动：systemctl start ${values.service}`);
  console.log(`管理接口：${join(values['data-dir'], 'run/whaled.sock')}（仅本机可连接）`);
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
