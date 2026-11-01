import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestQqAction, type ActionConnection } from './action-client.js';
import { socialTools } from '../qq/social-tools.js';
import { legacyTools } from '../qq/legacy-tools.js';
import { operationDigest } from '../core/operation-context.js';

export type QqToolSelection = string[] | null;

export function parseQqToolSelection(value: string | undefined): QqToolSelection {
  if (value === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('QQ 工具清单无效'); }
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== 'string')) throw new Error('QQ 工具清单无效');
  return parsed;
}

function result(value: unknown): { content: any[] } {
  if (value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)) return value as { content: any[] };
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/** 单个 MCP 会话的工具集；连接信息由 stdio 环境或桥接内部 HTTP 服务提供。 */
export function registerQqTools(server: McpServer, options: { connection?: ActionConnection; tools: QqToolSelection; transportInstance: string }): void {
  const legacy = new Set(legacyTools.map(tool => tool.name));
  for (const tool of [...socialTools, ...legacyTools].filter(tool => options.tools === null || options.tools.includes(tool.name))) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.schema as z.ZodRawShape }, async (args, extra) => {
      try {
        const operationId = operationDigest([options.transportInstance, String(extra.requestId)]);
        if (tool.name === 'qq_send_message') return result(await requestQqAction({ action: 'send_message', ...args } as never, extra.signal, operationId, options.connection));
        if (tool.name === 'qq_like') return result(await requestQqAction({ action: 'like', ...args } as never, extra.signal, operationId, options.connection));
        if (tool.name === 'qq_qzone_post') return result(await requestQqAction({ action: 'qzone_post', ...args } as never, extra.signal, operationId, options.connection));
        return result(await requestQqAction({ action: legacy.has(tool.name) ? 'legacy' : 'social', tool: tool.name, args }, extra.signal, operationId, options.connection));
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }; }
    });
  }
}
