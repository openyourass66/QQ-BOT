import { readFile, access, open, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readChatModelConfig } from '../dist/chat-model.js';
export async function environment(root) {
  return { ...process.env, ...parseEnv(await readFile(join(root, '.env'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })) };
}
export async function diagnose(root) {
  const env = await environment(root), rows = [];
  const add = (name, ok, detail, required = true) => rows.push({ name, ok, detail, required });
  try { const model = readChatModelConfig(env); add('对话模型配置', true, model.mode === 'profile' ? '沿用 DSH Profile' : `${model.model} · ${model.mode === 'project' ? '本项目 API Key' : 'DeepSeek 账号'}`); }
  catch (error) { add('对话模型配置', false, error.message); }
  const exists = async path => access(path).then(() => true, () => false);
  if (process.platform === 'win32' && env.QQBOT_LOW_INTEGRITY !== undefined) add('桌面进程完整性级别', env.QQBOT_LOW_INTEGRITY !== '1', env.QQBOT_LOW_INTEGRITY === '1' ? '程序继承了低完整性标签，会阻止托盘和 DSH 配置写入。请退出后运行 npm run desktop:build，重新生成普通用户级别的 EXE。' : '普通用户级别，可访问用户配置与系统托盘');
  add('Node.js 运行环境', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  add('机器人构建文件', await exists(join(root, 'dist/bridge.js')), '缺失时运行 npm run build');
  add('DSH 启动入口', !!env.BOT_DSH_BIN && await exists(resolve(root, env.BOT_DSH_BIN)), '检查连接设置中的 DSH 路径');
  const workspace = resolve(root, env.BOT_WORKSPACE || 'bot-workspace');
  add('机器人工作区', await stat(workspace).then(s => s.isDirectory(), () => false), '工作区必须是已存在的文件夹');
  const profile = env.BOT_DSH_PROFILE || 'acp';
  add('DSH Profile 名称', /^[\w-]+$/.test(profile), '只允许字母、数字、下划线和短横线');
  const profilePath = resolve(env.BOT_DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile, 'cordis.yml');
  try { const fd = await open(profilePath, 'r+'); await fd.close(); add('DSH Profile 写入权限', true, '配置文件可写'); }
  catch (e) { add('DSH Profile 写入权限', e.code === 'ENOENT', e.code === 'ENOENT' ? '首次启动由 DSH 创建' : `无法写入 cordis.yml（${e.code}），请关闭占用该文件的程序并检查访问权限`); }
  add('NapCat Shell', await exists(resolve(root, env.BOT_NAPCAT_DIR || 'napcat/shell', 'napcat.mjs')), '缺失时请部署官方 NapCat Shell');
  add('NapCat Node 适配库', await exists(join(root, 'napcat/node-runtime/QQNT.dll')), '需要官方 Node 模式 QQNT.dll');
  add('QQ 安装目录', !!env.BOT_QQ_DIR && await exists(resolve(root, env.BOT_QQ_DIR, 'versions/config.json')), '在连接设置中选择 QQ.exe 所在文件夹');
  for (const [key, protocols] of [['ONEBOT_HTTP_URL', ['http:', 'https:']], ['ONEBOT_WS_URL', ['ws:', 'wss:']]]) {
    let ok = false; try { ok = protocols.includes(new URL(env[key]).protocol); } catch {}
    add(key, ok, '检查 OneBot 连接地址和协议');
  }
  return { rows, ok: rows.every(row => row.ok || !row.required) };
}
export async function onebotOnline(root) {
  const env = await environment(root);
  try {
    const response = await fetch(new URL('get_status', (env.ONEBOT_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/?$/, '/')), { headers: env.ONEBOT_TOKEN ? { Authorization: `Bearer ${env.ONEBOT_TOKEN}` } : {}, signal: AbortSignal.timeout(1500) });
    const json = await response.json(); return response.ok && json.retcode === 0;
  } catch { return false; }
}
