import { readFile, access, open, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { readChatModelConfig } from '../dist/agent/chat-model.js';
import { readJsonLimited } from '../dist/services/read-json.js';
import WebSocket from 'ws';
import { installedComponent } from '../scripts/component-paths.mjs';

export async function probeSocket(env) {
  let url;
  try { url = new URL(env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001'); if (!['ws:','wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(); }
  catch { return false; }
  return new Promise(done => {
    const socket = new WebSocket(url, { headers: env.ONEBOT_TOKEN ? { authorization: `Bearer ${env.ONEBOT_TOKEN}` } : {}, handshakeTimeout: 1500, maxPayload: 65536 });
    let settled = false;
    const timer = setTimeout(() => finish(false), 2000);
    function finish(ok) { if (settled) return; settled = true; clearTimeout(timer); done(ok); socket.terminate(); }
    socket.once('open', () => finish(true)); socket.on('error', () => finish(false)); socket.once('close', () => finish(false));
  });
}

export async function environment(root) {
  return { ...process.env, ...parseEnv(await readFile(join(root, '.env'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })) };
}
export async function resolveExecutable(root, value, env) {
  if (!value) return '';
  const candidates = [resolve(root, value)];
  if (!/[\\/]/.test(value)) for (const path of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) candidates.push(join(path.replace(/^"|"$/g, ''), value));
  for (const path of candidates) if (await stat(path).then(s => s.isFile(), () => false)) return path;
  return '';
}
export async function probeOnebot(root, override) {
  const env = override || await environment(root);
  let reached = false;
  try {
    const base = new URL((env.ONEBOT_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/?$/, '/'));
    if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.hash) return { ok: false, reached: false, detail: '请检查 QQ HTTP 地址，勿在地址中填写账号或令牌。' };
    const response = await fetch(new URL('get_status', base), { headers: env.ONEBOT_TOKEN ? { Authorization: `Bearer ${env.ONEBOT_TOKEN}` } : {}, redirect: 'error', signal: AbortSignal.timeout(1500) });
    reached = true;
    if (!response.ok) { await response.body?.cancel(); return { ok: false, reached: true, detail: [401,403].includes(response.status) ? '服务可达，但令牌被拒绝；请与 NapCat 的 access_token 保持一致。' : `服务返回 HTTP ${response.status}，请确认地址对应 OneBot HTTP 服务。` }; }
    const json = await readJsonLimited(response, 65536);
    return json?.retcode === 0 ? { ok: true, reached: true, detail: 'OneBot HTTP 服务已连接；首次 QQ 登录请按日志完成。' } : { ok: false, reached: true, detail: '服务响应不是成功的 OneBot 状态，请检查服务与令牌。' };
  } catch { return { ok: false, reached, detail: reached ? '服务可达，但状态响应无效或超出限制；请确认填写的是 OneBot HTTP 地址。' : '暂时无法连接 QQ 服务；请先启动 NapCat，并检查地址、端口和防火墙。' }; }
}
export async function diagnose(root, { dataRoot = root, externalOnebot = false, env: override, probeConnection = false } = {}) {
  const env = override || await environment(dataRoot), rows = [];
  const external = env.BOT_ONEBOT_MODE === 'external' || env.BOT_ONEBOT_MODE !== 'managed' && externalOnebot;
  const add = (name, ok, detail, required = true, key = '') => rows.push({ name, ok, detail, required, key });
  add('QQ 接入方式', ['auto','managed','external'].includes(env.BOT_ONEBOT_MODE || 'auto'), '选择本机启动或连接已有服务；不确定时保留自动连接。', true, 'BOT_ONEBOT_MODE');
  try { const model = readChatModelConfig(env); add('对话模型配置', true, model.mode === 'profile' ? '沿用 DSH Profile；请先在 DSH 中完成模型配置或登录。' : `${model.model} · ${model.mode === 'project' ? '本项目 API Key（可点击测试连接验证）' : 'DeepSeek 账号（请先在 DSH 登录）'}`, true, 'BOT_CHAT_MODE'); }
  catch (error) { add('对话模型配置', false, error.message, true, 'BOT_CHAT_MODE'); }
  const exists = async path => access(path).then(() => true, () => false);
  const managed = await installedComponent('napcat', dataRoot, root);
  const managedSelected = Boolean(managed && resolve(dataRoot,env.BOT_NAPCAT_DIR || 'napcat/shell') === join(managed.directory,'napcat'));
  if (process.platform === 'win32' && env.QQBOT_LOW_INTEGRITY !== undefined) add('桌面进程完整性级别', env.QQBOT_LOW_INTEGRITY !== '1', env.QQBOT_LOW_INTEGRITY === '1' ? '请退出后运行 npm run desktop:build，重新生成普通用户级别的 EXE。' : '普通用户级别，可访问用户配置与系统托盘');
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('Node.js 运行环境', major === 22 && minor >= 13 || major >= 24, `${process.version}；需要 22.13–22.x 或 24 及以上。`);
  add('机器人构建文件', await exists(join(root, 'dist/bridge.js')), '缺失时在项目目录运行 npm run build。');
  add('DSH 启动入口', Boolean(await resolveExecutable(dataRoot, env.BOT_DSH_BIN, env)), '点击自动检测，或选择已安装 DSH 的 dsh.cmd / 可执行文件；未安装时查看安装指引。', true, 'BOT_DSH_BIN');
  const workspace = resolve(dataRoot, env.BOT_WORKSPACE || 'bot-workspace');
  add('机器人工作区', await stat(workspace).then(s => s.isDirectory(), () => false), '默认工作区自动初始化；自定义路径需选择已存在的目录。', true, 'BOT_WORKSPACE');
  const profile = env.BOT_DSH_PROFILE || 'acp';
  add('DSH Profile 名称', /^[\w-]+$/.test(profile), '默认 acp，无需修改；名称只允许字母、数字、下划线和短横线。', true, 'BOT_DSH_PROFILE');
  const profilePath = resolve(dataRoot, env.BOT_DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile, 'cordis.yml');
  try { const fd = await open(profilePath, 'r+'); await fd.close(); add('DSH Profile 写入权限', true, '配置文件可写'); }
  catch (e) { add('DSH Profile 写入权限', e.code === 'ENOENT', e.code === 'ENOENT' ? '首次启动由 DSH 创建' : `无法写入 cordis.yml（${e.code}），请关闭占用程序并检查文件权限。`); }
  add('NapCat Shell', await exists(resolve(dataRoot, env.BOT_NAPCAT_DIR || 'napcat/shell', 'napcat.mjs')), external ? '使用已有服务，无需本机 Shell。' : '按安装指引部署到数据目录的 napcat/shell；也可选择连接已有 QQ 服务。', !external, 'BOT_NAPCAT_DIR');
  add('NapCat Node 适配库', managedSelected || await exists(join(dataRoot, 'napcat/node-runtime/QQNT.dll')), external ? '使用已有服务，无需本机适配库。' : managedSelected ? '使用已准备组件内的官方适配库。' : '按安装指引在数据目录准备官方 Node 适配库 QQNT.dll，勿使用 QQ 目录的同名文件。', !external, 'BOT_NAPCAT_DIR');
  add('QQ 安装目录', managedSelected || !!env.BOT_QQ_DIR && await exists(resolve(dataRoot, env.BOT_QQ_DIR, 'versions/config.json')), external ? '使用已有服务，无需本机 QQ 目录。' : managedSelected ? '使用已准备的 QQ 运行文件，无需选择系统 QQ。' : '点击自动检测，或选择 QQ.exe 所在文件夹。', !external && !managedSelected, 'BOT_QQ_DIR');
  for (const [key, protocols, fallback] of [['ONEBOT_HTTP_URL', ['http:', 'https:'], 'http://127.0.0.1:3000'], ['ONEBOT_WS_URL', ['ws:', 'wss:'], 'ws://127.0.0.1:3001']]) {
    let ok = false; try { const url = new URL(env[key] || fallback); ok = protocols.includes(url.protocol) && !url.username && !url.password && !url.hash; } catch {}
    add(key === 'ONEBOT_HTTP_URL' ? 'QQ HTTP 地址' : 'QQ WebSocket 地址', ok, '本机默认端口为 3000 / 3001；须与 NapCat 设置一致。', true, key);
  }
  if (probeConnection) {
    const connection = await probeOnebot(root, env);
    const required = external || connection.reached;
    add('QQ 服务连接', connection.ok, !required && !connection.ok ? '本机服务将在启动时运行；若出现登录提示，请按日志完成。' : connection.detail, required, connection.reached ? 'ONEBOT_TOKEN' : 'ONEBOT_HTTP_URL');
    if (connection.ok) add('QQ 消息通道', await probeSocket(env), '核对正向 WebSocket 地址、端口和令牌；HTTP 可用不代表能收到 QQ 消息。', true, 'ONEBOT_WS_URL');
  }
  return { rows, ok: rows.every(row => row.ok || !row.required) };
}
export async function onebotOnline(root, override) { return (await probeOnebot(root, override)).ok; }
