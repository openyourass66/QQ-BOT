import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { ZodError } from 'zod';
import type { BotSettings } from './settings.js';
import { recentLogs, snapshotStatus } from './state.js';

export interface AdminDeps {
  getSettings(): BotSettings;
  saveSettings(input: unknown): Promise<BotSettings>;
  getPersona(): Promise<string>;
  savePersona(content: string): Promise<void>;
  getSessions(): Array<{ key: string; sessionId: string; updatedAt: number }>;
  deleteSession(key: string): void;
  testSend(text: string): Promise<unknown>;
  getLoginInfo(): Promise<unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 1_000_000;

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export async function startAdmin(deps: AdminDeps): Promise<{ close(): Promise<void>; url: string }> {
  const port = Number(process.env.ADMIN_UI_PORT ?? 6080);
  const host = '127.0.0.1';
  const token = process.env.ADMIN_UI_TOKEN ?? '';
  const publicDir = resolve(process.env.ADMIN_UI_DIR ?? 'public');

  const authorized = (req: IncomingMessage): boolean => {
    if (!token) return true;
    const header = req.headers['x-admin-token'];
    if (typeof header === 'string' && header === token) return true;
    const url = new URL(req.url ?? '/', `http://${host}`);
    return url.searchParams.get('token') === token;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const path = url.pathname;

      if (path.startsWith('/api/')) {
        const port = req.socket.localPort;
        if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
          sendJson(res, 403, { error: '无效的管理接口 Host' });
          return;
        }
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) {
          sendJson(res, 403, { error: '不允许跨站访问管理接口' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { error: '未授权，请检查 ADMIN_UI_TOKEN' });
          return;
        }
        await handleApi(req, res, url, deps);
        return;
      }

      await serveStatic(res, publicDir, path);
    } catch (error) {
      sendJson(res, error instanceof ZodError || error instanceof SyntaxError ? 400 : 500, { error: String(error) });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  const url = `http://${host}:${typeof address === 'object' && address ? address.port : port}`;
  console.log(`[admin] ${url}`);

  return {
    url,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function serveStatic(res: ServerResponse, publicDir: string, path: string): Promise<void> {
  const filePath = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  let target = resolve(publicDir, filePath);
  const within = (root: string, file: string): boolean => {
    const part = relative(root, file);
    return part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part);
  };
  if (!within(publicDir, target)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const [root, actual] = await Promise.all([realpath(publicDir), realpath(target)]);
    if (!within(root, actual)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    target = actual;
    const file = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AdminDeps,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/status') {
    sendJson(res, 200, { ...snapshotStatus(), settings: deps.getSettings() });
    return;
  }

  if (method === 'GET' && path === '/api/settings') {
    sendJson(res, 200, deps.getSettings());
    return;
  }

  if (method === 'PUT' && path === '/api/settings') {
    const body = await readBody(req);
    const saved = await deps.saveSettings(body);
    sendJson(res, 200, saved);
    return;
  }

  if (method === 'GET' && path === '/api/persona') {
    sendJson(res, 200, { content: await deps.getPersona() });
    return;
  }

  if (method === 'PUT' && path === '/api/persona') {
    const body = (await readBody(req)) as { content?: unknown };
    if (typeof body.content !== 'string') throw new Error('content 必须是字符串');
    await deps.savePersona(body.content);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/api/logs') {
    const after = Number(url.searchParams.get('after') ?? 0);
    sendJson(res, 200, { logs: recentLogs(Number.isFinite(after) ? after : 0), now: Date.now() });
    return;
  }

  if (method === 'GET' && path === '/api/sessions') {
    sendJson(res, 200, { sessions: deps.getSessions() });
    return;
  }

  if (method === 'DELETE' && path === '/api/sessions') {
    const key = url.searchParams.get('key');
    if (!key) throw new Error('缺少 key');
    deps.deleteSession(key);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/api/login-info') {
    sendJson(res, 200, await deps.getLoginInfo());
    return;
  }

  if (method === 'POST' && path === '/api/test') {
    const body = (await readBody(req)) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new Error('消息不能为空');
    sendJson(res, 200, await deps.testSend(text));
    return;
  }

  sendJson(res, 404, { error: 'unknown endpoint' });
}
