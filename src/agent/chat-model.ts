import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function restrictedToolPatches(): object[] {
  const disabled=['tool-bash','tool-pwsh','tool-jobs','tool-fs','tool-fs-search','tool-working-directory','tool-skill','tool-subagent-control','tool-subagent-list-agents','tool-subagent','tool-subagent-fork','tool-workflow','tool-todo','tool-goal','tool-plugin-manager','session-title-llm'];
  return [...disabled.map(id=>({id,disabled:true})),{id:'tools',config:{mode:'native'}},{insert:[{id:'whale-tool-policy',name:new URL('../security/dsh-policy.js',import.meta.url).href}]}];
}

export const projectChatKey = 'QQ_BOT_DEEPSEEK_API_KEY';
export const defaultChatBaseUrl = 'https://api.deepseek.com/anthropic';
export const defaultChatModel = 'deepseek-flash';

export function normalizeChatBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '/' || url.pathname === '/v1')) return defaultChatBaseUrl;
  } catch { /* Configuration validation reports invalid addresses below. */ }
  return baseUrl;
}

export interface ChatModelConfig {
  mode: 'profile' | 'project' | 'account';
  model: string;
  baseUrl: string;
  apiKey: string;
}

export function readChatModelConfig(env: Record<string, string | undefined>): ChatModelConfig {
  const mode = env.BOT_CHAT_MODE || 'profile';
  if (!['profile', 'project', 'account'].includes(mode)) throw new Error('连接配置格式无效：对话模型使用方式无效');
  const model = (env.BOT_CHAT_MODEL || defaultChatModel).trim();
  const baseUrl = normalizeChatBaseUrl(env.BOT_CHAT_BASE_URL || defaultChatBaseUrl);
  const apiKey = (env[projectChatKey] || '').trim();
  if (mode !== 'profile') {
    if (!model || model.length > 128 || /[\s\x00-\x1f\x7f]/u.test(model)) throw new Error('连接配置格式无效：模型 ID 应为 1–128 个字符，不可包含空白');
    if (mode === 'project') {
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw new Error('连接配置格式无效：对话模型 API 地址无效'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('连接配置格式无效：API 地址需使用 HTTP(S)，不可包含账号、查询参数或片段');
      if (!apiKey || apiKey.length > 512 || /[\s\x00-\x1f\x7f]/u.test(apiKey)) throw new Error('连接配置格式无效：请填写本项目的 API Key，不可包含空白');
    }
  }
  return { mode: mode as ChatModelConfig['mode'], model, baseUrl, apiKey };
}

export function chatModelSelection(config: ChatModelConfig): { provider: string; model: string } | undefined {
  return config.mode === 'profile' ? undefined : {
    provider: config.mode === 'account' ? 'deepseek-account' : 'deepseek-official', model: config.model,
  };
}

export function chatModelPatches(config: ChatModelConfig): object[] {
  const selection = chatModelSelection(config);
  if (!selection) return [];
  const patches: object[] = [
    { id: 'acp', config: selection },
    { id: 'agent-default-model', config: selection },
  ];
  if (config.mode === 'project') {
    patches.push({ id: 'llm-deepseek', config: {
      apiKeyEnv: projectChatKey, baseURL: config.baseUrl,
      // Preserve the shipped Flash image capabilities; custom routes declare text only.
      models: [{ id: config.model, ...(config.model === defaultChatModel ? {
        inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
      } : {}) }],
    } });
    patches.push({ id: 'web-search-deepseek', config: { apiKeyEnv: projectChatKey } });
    patches.push({ id: 'web-deepseek-api', config: { apiKeyEnv: projectChatKey } });
    // 受管服务器常经 fake-ip 代理 DNS 解析公网站点，本地 HTTP 抓取会以非公网地址拒绝；正文改由 DeepSeek Fetch API 读取。
    patches.push({ id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'deepseek-fetch-api' } });
  }
  return patches;
}

export async function prepareChatModelPatch(config: ChatModelConfig, sessionStore: string,maxOutputTokens=8192): Promise<string | undefined> {
  const patches = [...chatModelPatches(config),...restrictedToolPatches(),{id:'compaction-basic',config:{maxTokens:maxOutputTokens}}];
  const path = resolve(dirname(sessionStore), 'dsh', 'chat-model.patch.json');
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + `.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(patches, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
  return path;
}

function requireProjectApi(config: ChatModelConfig): void {
  if (config.mode !== 'project') throw new Error('连接配置格式无效：获取模型和测试连接需要选择“本项目 API Key”');
}

function httpFailure(status: number): Error {
  const detail = status === 401 || status === 403 ? 'API Key 无效或没有访问权限，请检查密钥'
    : status === 402 ? '账户余额不足，请充值后重试'
    : status === 404 ? '接口或模型不存在，请检查 API 地址和模型 ID'
    : status === 429 ? '请求受到限流，请稍后重试'
    : status >= 500 ? '模型服务暂时不可用，请稍后重试' : '模型服务拒绝请求，请检查模型 ID 与接口协议';
  return new Error(`连接配置格式无效：${detail}（HTTP ${status}）`);
}

async function requestJson(url: string, config: ChatModelConfig, body?: object): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${config.apiKey}`, 'x-api-key': config.apiKey,
        ...(body ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { await response.body?.cancel(); throw httpFailure(response.status); }
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('连接配置格式无效：')) throw error;
    throw new Error('连接配置格式无效：模型连接失败或超时，请检查网络、API 地址及 Messages 协议支持');
  }
}

export async function listChatModels(config: ChatModelConfig): Promise<string[]> {
  requireProjectApi(config);
  const url = new URL(config.baseUrl);
  url.pathname = url.pathname.replace(/\/anthropic(?:\/v1)?$/u, '').replace(/\/$/u, '') + '/models';
  const data = await requestJson(url.toString(), config) as { data?: { id?: unknown }[] };
  if (!Array.isArray(data?.data)) throw new Error('连接配置格式无效：服务未返回模型列表，可手动填写模型 ID 后测试连接');
  const models = [...new Set(data.data.map(item => item?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\s\x00-\x1f\x7f]/u.test(id)))].slice(0, 200);
  if (!models.length) throw new Error('连接配置格式无效：没有可用模型，请检查 API Key 权限');
  return models;
}

export async function testChatModel(config: ChatModelConfig): Promise<{ model: string; message: string }> {
  requireProjectApi(config);
  const root = config.baseUrl.endsWith('/v1') ? config.baseUrl : config.baseUrl + '/v1';
  const data = await requestJson(root + '/messages', config, {
    model: config.model, max_tokens: 16, stream: false, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  }) as { content?: { type?: string; text?: string }[] };
  if (!Array.isArray(data?.content) || !data.content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
    throw new Error('连接配置格式无效：接口未返回有效的 Messages 回复，请检查模型与协议支持');
  }
  return { model: config.model, message: `连接成功，${config.model} 已返回有效回复。` };
}
