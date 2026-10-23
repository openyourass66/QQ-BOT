import type { MessageEvent } from './onebot.js';

/** 按会话去重，逐条淘汰；容量达到上限时保留其余消息记录。 */
export class RecentMessages {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly capacity = 1000,
    private readonly ttlMs = 600_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || ttlMs <= 0) throw new Error('无效的去重缓存参数');
  }

  isDuplicate(event: Pick<MessageEvent, 'self_id' | 'message_type' | 'group_id' | 'user_id' | 'message_id'>): boolean {
    const now = this.now();
    for (const [key, timestamp] of this.entries) {
      if (now - timestamp < this.ttlMs) break;
      this.entries.delete(key);
    }
    const conversation = event.message_type === 'group' ? event.group_id : event.user_id;
    const key = `${event.self_id}:${event.message_type}:${conversation}:${event.message_id}`;
    if (this.entries.has(key)) return true;
    this.entries.set(key, now);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return false;
  }
}

export function splitForQq(text: string, max: number): string[] {
  if (!Number.isInteger(max) || max < 2) throw new Error('分片长度至少为 2');
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const breakAt = Math.max(...['\n', '。', '！', '？', '；'].map((mark) => window.lastIndexOf(mark)));
    let cut = breakAt + 1 >= max * 0.5 ? breakAt + 1 : max;
    // 不在 UTF-16 代理对中间拆开 emoji 等字符。
    const left = rest.charCodeAt(cut - 1);
    const right = rest.charCodeAt(cut);
    if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) cut--;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
