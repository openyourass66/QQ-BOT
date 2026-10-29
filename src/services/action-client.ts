import type { QqAction } from '../qq/qq-actions.js';
import type { SocialCall } from '../qq/social-tools.js';
import {randomUUID} from 'node:crypto';
import {operationDigest} from '../core/operation-context.js';

export async function requestQqAction(action: QqAction | SocialCall | { action: 'legacy'; tool: string; args: Record<string, unknown> }, signal?: AbortSignal,operationId=operationDigest(randomUUID())): Promise<unknown> {
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
  if(!/^[a-f0-9]{64}$/.test(operationId))throw new Error('动作请求编号无效');headers['x-bot-operation']=operationId;
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
