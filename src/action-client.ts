import type { QqAction } from './qq-actions.js';

export async function requestQqAction(action: QqAction, signal?: AbortSignal): Promise<unknown> {
  const url = process.env.BOT_ACTION_URL;
  const token = process.env.BOT_ACTION_TOKEN;
  if (!url || !token) throw new Error('动作策略服务未连接；请使用 bridge 自动挂载的 QQ MCP');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('动作策略服务地址必须是本机 HTTP 地址');
  }
  const timeout = AbortSignal.timeout(630_000);
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (process.env.BOT_ACTION_CONTEXT) headers['x-bot-conversation'] = process.env.BOT_ACTION_CONTEXT;
  const response = await fetch(new URL('/actions', parsed), {
    method: 'POST',
    headers,
    body: JSON.stringify(action),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const body = await response.json() as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `动作接口失败 (${response.status})`);
  return body.data;
}
