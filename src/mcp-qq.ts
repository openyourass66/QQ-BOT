import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { requestQqAction } from './action-client.js';
import { socialTools } from './social-tools.js';
import { legacyTools } from './legacy-tools.js';

const server = new McpServer({ name: 'qq', version: '2.0.0' });
function result(value: unknown): { content: any[] } {
  if (value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)) return value as { content: any[] };
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
for (const tool of [...socialTools, ...legacyTools]) {
  server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.schema as z.ZodRawShape }, async (args, extra) => {
    try {
      if (tool.name === 'qq_send_message') return result(await requestQqAction({ action: 'send_message', ...args } as never, extra.signal));
      if (tool.name === 'qq_like') return result(await requestQqAction({ action: 'like', ...args } as never, extra.signal));
      if (tool.name === 'qq_qzone_post') return result(await requestQqAction({ action: 'qzone_post', ...args } as never, extra.signal));
      return result(await requestQqAction({ action: legacyTools.some(t => t.name === tool.name) ? 'legacy' : 'social', tool: tool.name, args }, extra.signal));
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }; }
  });
}
await server.connect(new StdioServerTransport());
console.error('[mcp-qq] ready');
