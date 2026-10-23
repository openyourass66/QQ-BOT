import WebSocket from 'ws';

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

export interface OneBotResponse<T> {
  status: string;
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
}

export class OneBotHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await response.json()) as OneBotResponse<T>;
    if (!response.ok || body.status !== 'ok' || body.retcode !== 0) {
      const detail = body.message ?? body.wording ?? response.statusText;
      throw new Error(`OneBot ${action} 失败 (${body.retcode ?? response.status}): ${detail}`);
    }
    return body.data;
  }

  sendPrivate(userId: number, text: string): Promise<{ message_id: number }> {
    return this.call('send_private_msg', { user_id: userId, message: text, auto_escape: true });
  }

  sendGroup(groupId: number, text: string): Promise<{ message_id: number }> {
    return this.call('send_group_msg', { group_id: groupId, message: text, auto_escape: true });
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
}

/** 正向 WebSocket 长连接；断线后按固定间隔重连。 */
export class OneBotWs {
  private ws?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;

  constructor(private readonly options: OneBotWsOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const headers: Record<string, string> = {};
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;

    const ws = new WebSocket(this.options.url, { headers });
    this.ws = ws;

    ws.on('open', () => {
      this.options.onState?.(true);
      this.options.onLog?.('[onebot] websocket connected');
    });
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { post_type?: string };
        if (parsed.post_type === 'message') {
          this.options.onEvent(parsed as MessageEvent);
        }
      } catch (error) {
        this.options.onLog?.(`[onebot] bad frame: ${String(error)}`);
      }
    });
    ws.on('close', () => {
      this.options.onState?.(false);
      this.scheduleReconnect();
    });
    ws.on('error', (error) => {
      this.options.onState?.(false);
      this.options.onLog?.(`[onebot] websocket error: ${error.message}`);
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    this.options.onLog?.('[onebot] reconnecting in 3s');
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, 3000);
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
