import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** ACP mcpServers 条目可能是 stdio，也可能是桥接内 HTTP 服务。 */
export function headersOf(server) {
  return Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value]));
}

export async function connectFixture(server, name = 'fixture-agent') {
  const client = new Client({ name, version: '1' });
  try {
    if (server.type === 'http') {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: headersOf(server) } }));
    } else {
      await client.connect(new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: Object.fromEntries((server.env ?? []).map(({ name: key, value }) => [key, value])),
        stderr: 'pipe',
      }));
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}

/** 直接用 JSON-RPC 调用，才能固定请求编号验证去重与冲突。 */
export async function openRawMcp(server) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headersOf(server) };
  const init = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replay-fixture', version: '1' } } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!init.ok) throw new Error(`MCP 初始化失败 (${init.status})`);
  const session = init.headers.get('mcp-session-id');
  if (!session) throw new Error('MCP 未返回会话编号');
  const body = await init.json();
  const sessionHeaders = { ...headers, 'mcp-session-id': session, 'mcp-protocol-version': body.result?.protocolVersion ?? '2025-06-18' };
  const ready = await fetch(server.url, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(15000) });
  await ready.text();
  return {
    async call(id, name, args) {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json();
      const result = payload?.result;
      return {
        status: response.status,
        isError: Boolean(payload?.error || result?.isError),
        error: payload?.error?.message,
        text: result?.content?.find(entry => entry.type === 'text')?.text,
      };
    },
  };
}
