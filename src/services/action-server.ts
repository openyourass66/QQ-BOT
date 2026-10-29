import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';

export interface ActionServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** 内部接口独立于管理页面，避免把动作执行权限暴露给前端。 */
export async function startActionServer(
  execute: (input: unknown, signal: AbortSignal, conversation?: string,operationId?:string) => Promise<unknown>,
): Promise<ActionServer> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const active = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown): void => {
      if (res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      send(401, { error: '动作接口未授权' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/actions') {
      send(404, { error: '未知动作接口' });
      return;
    }
    if(active.size>=32){req.resume();send(429,{error:'动作正在处理，请稍后重试。'});return;}
    const operationId=req.headers['x-bot-operation'];if(operationId!==undefined&&(typeof operationId!=='string'||!/^[a-f0-9]{64}$/.test(operationId))){req.resume();send(400,{error:'动作请求编号无效'});return;}
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => controller.abort();
    req.once('aborted', cancel);
    res.once('close', cancel);
    const timer = setTimeout(cancel, 630_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262_144) {
          send(413, { error: '请求体过大' });
          return;
        }
        chunks.push(chunk);
      }
      controller.signal.throwIfAborted();
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const conversation = req.headers['x-bot-conversation'];
      const data = await execute(input, controller.signal, typeof conversation === 'string' ? conversation : undefined,typeof operationId==='string'?operationId:undefined);
      send(200, { data });
    } catch (error) {
      const code = error instanceof ZodError || error instanceof SyntaxError ? 400 : 409;
      send(code, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动动作接口');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () => new Promise<void>((resolveClose, reject) => {
      for (const controller of active) controller.abort();
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}
