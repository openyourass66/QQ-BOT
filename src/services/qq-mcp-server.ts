import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { parseQqToolSelection, registerQqTools, type QqToolSelection } from './qq-tools.js';
import type { ActionConnection } from './action-client.js';

export interface QqMcpServer {
  url: string;
  token: string;
  /** ACP 会话释放后关闭对应的 MCP 会话；DSH 不发送 DELETE。 */
  closeContext(context: string): void;
  close(): Promise<void>;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  context: string;
  last: number;
}

const MAX_BODY = 256 * 1024;
const MAX_SESSIONS = 1024;
/** 所属 ACP 会话已不存在的残留连接，尽早清理；正常释放由 closeContext 负责。 */
const ORPHAN_MS = 5 * 60_000;
/** 极端情况下仍未被识别的残留连接，最多保留一天。 */
const IDLE_MS = 24 * 60 * 60_000;

/**
 * 在桥接进程内提供 QQ 工具 MCP：每个 ACP 会话通过 HTTP 连接，
 * 不再为每个会话启动独立的 Node 子进程。鉴权与上下文仍按会话隔离。
 */
export async function startQqMcpServer(action: ActionConnection, options?: { liveContexts?: () => Set<string> }): Promise<QqMcpServer> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const sessions = new Map<string, SessionEntry>();
  const byContext = new Map<string, Set<string>>();

  const detach = (id: string): void => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    const set = byContext.get(entry.context);
    set?.delete(id);
    if (set && !set.size) byContext.delete(entry.context);
    void entry.server.close().catch(() => undefined);
  };

  const reply = (res: ServerResponse, code: number, body: unknown): void => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      const authorization = Buffer.from(req.headers.authorization ?? '');
      if (req.headers.origin || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        reply(res, 401, { error: 'QQ MCP 未授权' });
        return;
      }
      if (req.url !== '/mcp') { reply(res, 404, { error: '未知 MCP 接口' }); return; }
      const context = req.headers['x-whale-context'];
      if (typeof context !== 'string' || !/^[a-f0-9]{48}$/.test(context)) { reply(res, 400, { error: 'MCP 会话上下文无效' }); return; }
      if (req.method === 'GET') { reply(res, 405, { error: 'QQ MCP 不支持服务端推送' }); return; }

      const sessionId = req.headers['mcp-session-id'];
      if (req.method === 'DELETE') {
        const entry = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        if (!entry) { reply(res, 404, { error: 'MCP 会话不存在' }); return; }
        if (entry.context !== context) { reply(res, 403, { error: 'MCP 会话不匹配' }); return; }
        await entry.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== 'POST') { reply(res, 405, { error: '不支持的 MCP 方法' }); return; }

      const body = await readBody(req);
      if (typeof sessionId === 'string') {
        const entry = sessions.get(sessionId);
        if (!entry) { reply(res, 404, { error: 'MCP 会话不存在' }); return; }
        if (entry.context !== context) { reply(res, 403, { error: 'MCP 会话不匹配' }); return; }
        entry.last = Date.now();
        await entry.transport.handleRequest(req, res, body);
        return;
      }

      const request = body as { method?: unknown } | undefined;
      if (!request || typeof request !== 'object' || Array.isArray(request) || request.method !== 'initialize') {
        reply(res, 400, { error: 'MCP 会话尚未初始化' });
        return;
      }
      if (sessions.size >= MAX_SESSIONS) { reply(res, 503, { error: 'MCP 会话过多' }); return; }
      let tools: QqToolSelection;
      try { tools = parseQqToolSelection(typeof req.headers['x-whale-tools'] === 'string' ? req.headers['x-whale-tools'] : undefined); }
      catch { reply(res, 400, { error: 'QQ 工具清单无效' }); return; }

      const mcp = new McpServer({ name: 'qq', version: '2.0.0' });
      registerQqTools(mcp, { connection: { url: action.url, token: action.token, context }, tools, transportInstance: randomUUID() });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        maxRequestBodySize: MAX_BODY,
        onsessioninitialized: id => {
          const entry: SessionEntry = { transport, server: mcp, context, last: Date.now() };
          sessions.set(id, entry);
          const set = byContext.get(context) ?? new Set<string>();
          set.add(id);
          byContext.set(context, set);
        },
        onsessionclosed: id => detach(id),
      });
      transport.onclose = () => { const id = transport.sessionId; if (id) detach(id); };
      transport.onerror = error => console.error(`[qq-mcp] ${error.message}`);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) reply(res, error && (error as { status?: number }).status === 413 ? 413 : 500, { error: error instanceof Error ? error.message : String(error) });
      else res.destroy();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动 QQ MCP 服务');

  const sweeper = setInterval(() => {
    const now = Date.now(), live = options?.liveContexts?.();
    for (const [id, entry] of sessions) {
      const idle = now - entry.last;
      if (idle > IDLE_MS || (live && idle > ORPHAN_MS && !live.has(entry.context))) detach(id);
    }
  }, 60_000);
  sweeper.unref();

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    closeContext: context => {
      const set = byContext.get(context);
      if (!set) return;
      for (const id of [...set]) detach(id);
    },
    close: async () => {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) detach(id);
      await new Promise<void>((resolveClose, reject) => {
        server.close(error => error ? reject(error) : resolveClose());
        server.closeAllConnections();
      });
    },
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolveBody(undefined); return; }
      try { resolveBody(JSON.parse(text)); } catch { reject(Object.assign(new Error('请求体不是有效 JSON'), { status: 400 })); }
    });
    req.once('error', reject);
  });
}
