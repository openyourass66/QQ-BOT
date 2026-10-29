import WebSocket from 'ws';
import { z } from 'zod';

export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

export interface Sender {
  user_id: number;
  nickname: string;
  card?: string;
}

export interface MessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  time: number;
  self_id: number;
  user_id: number;
  message_id: number;
  raw_message: string;
  message: Segment[];
  sender: Sender;
  group_id?: number;
}

export const MESSAGE_LIMITS = { segments: 128, textBytes: 32 * 1024, eventBytes: 256 * 1024, noticeBytes: 16 * 1024 } as const;

/** 兼容 OneBot 的 CQ 字符串格式；转义文本不能伪装成真正的 @ 消息段。 */
export function parseCqMessage(message: string): Segment[] {
  const decode = (text: string): string => text.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
  const segments: Segment[] = [];
  const pattern = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let offset = 0;
  for (const match of message.matchAll(pattern)) {
    if (match.index! > offset) segments.push({ type: 'text', data: { text: decode(message.slice(offset, match.index)) } });
    const data: Record<string, unknown> = {};
    for (const item of match[2].slice(1).split(',')) {
      const index = item.indexOf('=');
      if (index > 0) data[item.slice(0, index)] = decode(item.slice(index + 1));
    }
    segments.push({ type: match[1], data }); offset = match.index! + match[0].length;
  }
  if (offset < message.length) segments.push({ type: 'text', data: { text: decode(message.slice(offset)) } });
  return segments;
}

const MessageSchema = z.object({
  post_type: z.literal('message'),
  message_type: z.enum(['private', 'group']),
  time: z.number().int().nonnegative(),
  self_id: z.number().int().positive().safe(),
  user_id: z.number().int().positive().safe(),
  message_id: z.number().int().safe(),
  raw_message: z.string().default(''),
  message: z.union([z.array(z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) })), z.string().transform(parseCqMessage)]),
  sender: z.object({
    user_id: z.number().int().positive().safe().optional(),
    nickname: z.string().default(''),
    card: z.string().optional(),
  }),
  group_id: z.number().int().positive().safe().optional(),
}).refine((event) => event.message_type !== 'group' || event.group_id !== undefined, {
  message: '群消息缺少 group_id', path: ['group_id'],
});

export function parseMessageEvent(input: unknown): MessageEvent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const candidate = input as Record<string, unknown>;
  let message = candidate.message;
  // Check collection bounds before schema validation visits every element.
  if (Array.isArray(message) && message.length > MESSAGE_LIMITS.segments) return;
  if (typeof message === 'string' && Buffer.byteLength(message) > MESSAGE_LIMITS.textBytes) return;
  try { if (Buffer.byteLength(JSON.stringify(input)) > MESSAGE_LIMITS.eventBytes) return; }
  catch { return; }
  if (typeof message === 'string') message = parseCqMessage(message);
  if (Array.isArray(message)) {
    if (message.length > MESSAGE_LIMITS.segments) return;
    let textBytes = 0;
    for (const segment of message) {
      if (segment?.type !== 'text') continue;
      if (typeof segment.data?.text !== 'string') return;
      textBytes += Buffer.byteLength(segment.data.text);
      if (textBytes > MESSAGE_LIMITS.textBytes) return;
    }
  }
  const result = MessageSchema.safeParse({ ...candidate, message });
  if (!result.success) return undefined;
  return { ...result.data, sender: { ...result.data.sender, user_id: result.data.sender.user_id ?? result.data.user_id } };
}

export interface OneBotResponse<T> {
  status: string;
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
}

export type OneBotInvocation={action:string;params:Readonly<Record<string,unknown>>;signal?:AbortSignal};
export type OneBotInterceptor=(call:OneBotInvocation,execute:()=>Promise<unknown>)=>Promise<unknown>;
export class OneBotHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly intercept?:OneBotInterceptor,
  ) {}

  get hasLocalMedia(): boolean {
    try {
      const url = new URL(this.baseUrl);
      return ['http:', 'https:'].includes(url.protocol) && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
    } catch { return false; }
  }

  async call<T = unknown>(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const body=JSON.stringify(params),snapshot=JSON.parse(body) as Record<string,unknown>,pending:object[]=[snapshot];
    while(pending.length){const value=pending.pop()!;for(const child of Object.values(value))if(child&&typeof child==='object')pending.push(child);Object.freeze(value);}
    const execute=()=>this.perform<T>(action,body,signal);return this.intercept?this.intercept({action,params:snapshot,signal},execute) as Promise<T>:execute();
  }
  private async perform<T>(action:string,requestBody:string,signal?:AbortSignal):Promise<T>{
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}/${action}`, {
      method: 'POST',
      headers,
      body:requestBody,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });

    const body = (await response.json()) as OneBotResponse<T>;
    if (!response.ok || body.status !== 'ok' || body.retcode !== 0) {
      const detail = body.message ?? body.wording ?? response.statusText;
      throw new Error(`OneBot ${action} 失败 (${body.retcode ?? response.status}): ${detail}`);
    }
    return body.data;
  }

  sendPrivate(userId: number, text: string, signal?: AbortSignal): Promise<{ message_id: number }> {
    return this.call('send_private_msg', { user_id: userId, message: text, auto_escape: true }, signal);
  }

  sendGroup(groupId: number, text: string, signal?: AbortSignal): Promise<{ message_id: number }> {
    return this.call('send_group_msg', { group_id: groupId, message: text, auto_escape: true }, signal);
  }

  markRead(messageId: number): Promise<unknown> {
    return this.call('mark_msg_as_read', { message_id: messageId });
  }
}

export interface OneBotWsOptions {
  url: string;
  token: string;
  onEvent: (event: MessageEvent) => void;
  onState?: (connected: boolean) => void;
  onLog?: (message: string) => void;
  onHeartbeat?: (online: boolean) => void;
  onNotice?: (event: Record<string, unknown>) => void;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
}

/** 正向 WebSocket 长连接；检测失活连接，并在断线后重连。 */
export class OneBotWs {
  private ws?: WebSocket;
  private stopped = true;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly options: OneBotWsOptions) {
    for (const value of [options.heartbeatIntervalMs, options.handshakeTimeoutMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('无效的 WebSocket 超时');
    }
    if (options.reconnectDelayMs !== undefined && (!Number.isSafeInteger(options.reconnectDelayMs) || options.reconnectDelayMs < 0)) {
      throw new Error('无效的 WebSocket 重连间隔');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.options.onState?.(false);
    ws?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const headers: Record<string, string> = {};
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;

    const ws = new WebSocket(this.options.url, {
      headers, handshakeTimeout: this.options.handshakeTimeoutMs ?? 10_000, maxPayload: 1_048_576,
    });
    this.ws = ws;
    let alive = true;

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) { ws.terminate(); return; }
      this.options.onState?.(true);
      this.options.onLog?.('[onebot] websocket connected');
      this.heartbeat = setInterval(() => {
        if (!alive) {
          this.options.onLog?.('[onebot] heartbeat timeout');
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, this.options.heartbeatIntervalMs ?? 30_000);
    });
    ws.on('pong', () => { alive = true; });
    ws.on('message', (raw) => {
      if (this.stopped || this.ws !== ws) return;
      alive = true;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== 'object') return;
        const frame = parsed as Record<string, unknown>;
        if (frame.post_type === 'message') {
          const event = parseMessageEvent(parsed);
          if (event) this.options.onEvent(event);
          else this.options.onLog?.('[onebot] invalid message event ignored');
        } else if (frame.post_type === 'notice' || frame.post_type === 'request') {
          if (Number.isSafeInteger(frame.self_id) && Number(frame.self_id) > 0 &&
            (typeof frame.notice_type === 'string' || typeof frame.request_type === 'string')) this.options.onNotice?.(frame);
        } else if (frame.post_type === 'meta_event' && frame.meta_event_type === 'heartbeat') {
          const status = frame.status as { online?: unknown } | undefined;
          if (typeof status?.online === 'boolean') this.options.onHeartbeat?.(status.online);
        }
      } catch (error) {
        this.options.onLog?.(`[onebot] bad frame: ${String(error)}`);
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.ws = undefined;
      this.options.onState?.(false);
      this.scheduleReconnect();
    });
    ws.on('error', (error) => {
      if (this.stopped || this.ws !== ws) return;
      this.options.onState?.(false);
      this.options.onLog?.(`[onebot] websocket error: ${error.message}`);
      if (ws.readyState === WebSocket.OPEN) ws.terminate();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    const delay = this.options.reconnectDelayMs ?? 3000;
    this.options.onLog?.(`[onebot] reconnecting in ${delay}ms`);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, delay);
  }
}

/** 把消息段压平成模型可读的文本。 */
export function segmentsToText(segments: Segment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        parts.push(String(segment.data.text ?? ''));
        break;
      case 'at':
        parts.push(`@${String(segment.data.qq ?? '')}`);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'reply':
        parts.push('[引用消息]');
        break;
      case 'forward': parts.push('[合并转发聊天记录]'); break;
      case 'file': parts.push(`[文件：${String(segment.data.name ?? '未知文件')}]`); break;
      default:
        break;
    }
  }
  return parts.join('').trim();
}

/** 去掉 @机器人 本身，并清理多余空白。 */
export function stripMention(segments: Segment[], selfId: number): Segment[] {
  return segments.filter(
    (segment) => !(segment.type === 'at' && Number(segment.data.qq) === selfId),
  );
}
