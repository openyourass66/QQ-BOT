import { parseEnv } from 'node:util';
import { readChatModelConfig, defaultChatBaseUrl, defaultChatModel, normalizeChatBaseUrl } from '../dist/agent/chat-model.js';

export const chatRuntimeKeys = new Set(['BOT_CHAT_MODE', 'BOT_CHAT_MODEL', 'BOT_CHAT_BASE_URL', 'QQ_BOT_DEEPSEEK_API_KEY']);
export const initialDefaultKeys = new Set(['ADMIN_QQ','GROUP_PREFIX','GROUP_COOLDOWN_MS','GROUP_CONTEXT_LINES','REPLY_CHUNK_SIZE','MIN_DELAY_MS','MAX_DELAY_MS','ALLOW_EXEC']);

export const runtimeFields = [
  ['账号接入方式', 'BOT_ONEBOT_MODE', 'QQ 接入方式', 'auto', 'onebot-mode'],
  ['后台分析服务', 'BOT_LEARNING_BASE_URL', '独立分析地址（Messages，留空复用项目地址）', ''],
  ['后台分析服务', 'BOT_LEARNING_API_KEY', '独立分析密钥（留空复用项目 Key）', '', 'secret'],
  ['后台分析服务', 'BOT_LEARNING_MODEL', '分析模型（留空复用对话模型名称）', ''],
  ['模型选择', 'BOT_CHAT_MODE', '使用方式', 'profile', 'chat-mode'],
  ['模型选择', 'BOT_CHAT_MODEL', '对话模型', defaultChatModel, 'chat-model'],
  ['模型选择', 'QQ_BOT_DEEPSEEK_API_KEY', '本项目 API Key', '', 'secret'],
  ['模型选择', 'BOT_CHAT_BASE_URL', 'API 地址', defaultChatBaseUrl],
  ['媒体服务连接', 'BOT_MEDIA_BASE_URL', '媒体服务地址（兼容 API 的 /v1/）', ''], ['媒体服务连接', 'BOT_MEDIA_API_KEY', '媒体服务密钥', '', 'secret'], ['媒体服务连接', 'BOT_FFMPEG_BIN', 'FFmpeg 文件（视频抽帧）', '', 'file'],
  ['空间浏览与评论', 'BOT_QZONE_ADAPTER_URL', '空间浏览与评论服务地址', ''], ['空间浏览与评论', 'BOT_QZONE_ADAPTER_TOKEN', '空间适配服务令牌', '', 'secret'],
  ['社交数据', 'BOT_SOCIAL_STORE', '社交数据文件（留空自动选择）', ''], ['社交数据', 'BOT_MEDIA_DIR', '媒体库目录（留空自动选择）', '', 'folder'], ['社交数据', 'BOT_MEDIA_IMPORT_DIRS', '允许导入的媒体目录（多个用 | 分隔）', ''],
  ['OneBot 连接', 'ONEBOT_HTTP_URL', 'HTTP 地址', 'http://127.0.0.1:3000'], ['OneBot 连接', 'ONEBOT_WS_URL', 'WebSocket 地址', 'ws://127.0.0.1:3001'], ['OneBot 连接', 'ONEBOT_TOKEN', '连接令牌', '', 'secret'],
  ['账号与 NapCat', 'BOT_SELF_ID', '机器人 QQ（0 为自动识别）', '0'], ['账号与 NapCat', 'BOT_QQ_DIR', 'QQ 安装目录', '', 'folder'], ['账号与 NapCat', 'BOT_NAPCAT_DIR', 'NapCat Shell 目录', 'napcat/shell', 'folder'],
  ['模型运行环境', 'BOT_DSH_BIN', 'DSH 启动文件', '', 'file'], ['模型运行环境', 'BOT_DSH_PROFILE', 'DSH Profile', 'acp'], ['模型运行环境', 'BOT_DSH_HOME', 'DSH 数据目录（留空使用默认值）', '', 'folder'], ['数据存储', 'BOT_WORKSPACE', '机器人工作区', 'bot-workspace', 'folder'],
  ['消息与并发', 'TURN_TIMEOUT_MS', '模型超时（毫秒）', '180000'], ['消息与并发', 'QUEUE_PER_CONVERSATION', '每会话队列容量', '5'], ['消息与并发', 'QUEUE_TOTAL', '总队列容量', '50'], ['消息与并发', 'MAX_CONCURRENT_TURNS', '模型并发数', '4'],
  ['数据存储', 'BOT_SETTINGS_FILE', '动态配置文件', 'bot.config.json'], ['数据存储', 'SESSION_STORE', '会话记录', 'data/sessions.json'], ['数据存储', 'BOT_USAGE_STORE', '额度记录（留空使用默认值）', ''], ['数据存储', 'BOT_GROUP_CONTEXT_STORE', '群上下文（留空使用默认值）', ''],
  ['初始默认值 · 动态设置优先', 'ADMIN_QQ', '管理员 QQ 默认值', '0'], ['初始默认值 · 动态设置优先', 'GROUP_PREFIX', '群聊前缀默认值', ''], ['初始默认值 · 动态设置优先', 'GROUP_COOLDOWN_MS', '群聊冷却默认值', '3000'], ['初始默认值 · 动态设置优先', 'GROUP_CONTEXT_LINES', '群聊摘要行数默认值', '6'], ['初始默认值 · 动态设置优先', 'REPLY_CHUNK_SIZE', '分片字符数默认值', '600'], ['初始默认值 · 动态设置优先', 'MIN_DELAY_MS', '最短回复延迟默认值', '700'], ['初始默认值 · 动态设置优先', 'MAX_DELAY_MS', '最长回复延迟默认值', '2400'], ['初始默认值 · 动态设置优先', 'ALLOW_EXEC', '自动执行命令默认值（0 / 1）', '0'],
];

export function mergeRuntimeEnv(original, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('连接配置格式无效');
  const allowed = new Set(runtimeFields.map(field => field[1]));
  let text = original;
  for (const [key, input] of Object.entries(data)) {
    const value = key === 'BOT_CHAT_BASE_URL' && typeof input === 'string' && input.trim() ? normalizeChatBaseUrl(input) : input;
    if (!allowed.has(key) || typeof value !== 'string' || /[\r\n\0"]/u.test(value)) throw new Error('连接配置格式无效：输入不可包含换行或双引号');
    const quote = value.includes("'") ? '"' : "'";
    const line = `${key}=${quote}${value}${quote}`;
    if (parseEnv(line)[key] !== value) throw new Error('连接配置格式无效：无法原样保存该字段的引号或转义字符');
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    if (!value && ['BOT_USAGE_STORE', 'BOT_GROUP_CONTEXT_STORE', 'BOT_DSH_HOME'].includes(key)) { text = text.replace(pattern, ''); continue; }
    if (pattern.test(text)) text = text.replace(pattern, () => line);
    else text += `\n${line}`;
  }
  return text;
}

export function validateRuntimeEnv(data) {
  if (typeof data !== 'string' || data.includes('\0')) throw new Error('连接配置格式无效');
  const parsed = parseEnv(data);
  if (parsed.BOT_ONEBOT_MODE && !['auto','managed','external'].includes(parsed.BOT_ONEBOT_MODE)) throw new Error('连接配置格式无效：QQ 接入方式无效');
  readChatModelConfig(parsed);
  for (const key of runtimeFields.map(field => field[1]).filter(key => key.endsWith('_URL'))) if (parsed[key] && (key !== 'BOT_CHAT_BASE_URL' || parsed.BOT_CHAT_MODE === 'project')) {
    let url;
    try { url = new URL(parsed[key]); } catch { throw new Error('连接配置格式无效：' + key + ' 地址无效'); }
    if (!(key === 'ONEBOT_WS_URL' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)) throw new Error(key + ' 协议无效');
  }
  if (parsed.BOT_DSH_PROFILE && !/^[\w-]+$/.test(parsed.BOT_DSH_PROFILE)) throw new Error('连接配置格式无效：Profile 只允许字母、数字、下划线和短横线');
  for (const [key, min, max] of [['TURN_TIMEOUT_MS',1000,600000],['QUEUE_PER_CONVERSATION',1,100],['QUEUE_TOTAL',1,1000],['MAX_CONCURRENT_TURNS',1,32],['BOT_SELF_ID',0,Number.MAX_SAFE_INTEGER],['ADMIN_QQ',0,Number.MAX_SAFE_INTEGER]]) {
    if (parsed[key] && (!/^\d+$/.test(parsed[key]) || Number(parsed[key]) < min || Number(parsed[key]) > max)) throw new Error(`连接配置格式无效：${key} 范围 ${min}–${max}`);
  }
}
