import { stat } from 'node:fs/promises';
import { dirname, join, resolve, parse } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { diagnose, environment, onebotOnline } from './diagnostics.mjs';
import { installedComponent, programRoot } from '../scripts/component-paths.mjs';
import { resolveCredentialEnv } from '../scripts/credentials.mjs';

const execute = promisify(execFile);
const isFile = path => stat(path).then(s => s.isFile(), () => false);
const isQQ = path => isFile(join(path, 'versions/config.json'));

// Search known locations and running application paths, never disk-wide or online.
export async function detectEnvironment(root, env, { runningPaths, platform = process.platform, programRoot: catalogRoot = programRoot } = {}) {
  if (!runningPaths) {
    runningPaths = [];
    if (platform === 'win32') {
      try {
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-Process -Name QQ,'DeepSeek Harness',deepseek-harness -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ }) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 2500, maxBuffer: 32000 });
        const paths = JSON.parse(stdout || '[]');
        runningPaths = Array.isArray(paths) ? paths : [paths];
      } catch { /* Manual selection and known paths remain available. */ }
    }
  }
  const drive = parse(resolve(root)).root;
  const bases = platform === 'win32' ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)'], drive].filter(Boolean) : [];
  const dsh = [env.BOT_DSH_BIN && resolve(root, env.BOT_DSH_BIN), ...(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(p => join(p.replace(/^"|"$/g, ''), platform === 'win32' ? 'dsh.cmd' : 'dsh')),
    ...bases.map(p => join(p, 'DeepSeek Harness', 'resources/runtime/cli/bin/dsh.cmd')),
    ...runningPaths.filter(p => typeof p === 'string' && /harness/i.test(p)).map(p => join(dirname(p), 'resources/runtime/cli/bin/dsh.cmd'))];
  const qq = [env.BOT_QQ_DIR && resolve(root, env.BOT_QQ_DIR), ...runningPaths.filter(p => typeof p === 'string' && /[\\/]QQ\.exe$/i.test(p)).map(p => dirname(p)), ...bases.flatMap(p => [join(p, 'Tencent/QQ'), join(p, 'QQ')])];
  const managed = await installedComponent('dsh', root, catalogRoot, platform);
  if (managed) dsh.splice(1,0,join(managed.directory, platform === 'win32' ? 'dsh.cmd' : 'dsh'));
  const suggestions = [];
  for (const [key, candidates, check] of [['BOT_DSH_BIN', dsh, isFile], ['BOT_QQ_DIR', qq, isQQ]]) {
    for (const path of [...new Set(candidates.filter(Boolean))]) {
      if (await check(path)) { suggestions.push({ key, value: path }); break; }
    }
  }
  return { operation: 'detect', suggestions, message: suggestions.length ? '已找到可用路径，仅补全空白或默认项；保存后生效。' : '未找到可用路径，请选择已安装的程序，或查看安装指引。' };
}

export async function checkSetup(root, draft, { dataRoot = root } = {}) {
  const env = await resolveCredentialEnv(dataRoot,{ ...await environment(dataRoot), ...draft });
  const external = env.BOT_ONEBOT_MODE === 'external' || env.BOT_ONEBOT_MODE !== 'managed' && await onebotOnline(root, env);
  const result = await diagnose(root, { dataRoot, externalOnebot: external, env, probeConnection: true });
  return { operation: 'check', ...result, message: result.ok ? '基础检查通过。可保存并启动；QQ 登录和模型实际连接以运行状态为准。' : '请处理标记为“需处理”的项目，再重新检查。' };
}
