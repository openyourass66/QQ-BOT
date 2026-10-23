export type LogLevel = 'info' | 'warn' | 'error';

/** 子进程的 stderr 也可能承载普通运行消息，优先使用消息中的显式级别。 */
export function subprocessLogLevel(message: string): LogLevel {
  const marker = message.match(/\[(info|warn|error)\]/i)?.[1]?.toLowerCase();
  if (marker === 'info' || marker === 'warn' || marker === 'error') return marker;
  if (/\b(error|exception|failed|fatal)\b|失败|错误/i.test(message)) return 'error';
  if (/\bwarn(?:ing)?\b|警告/i.test(message)) return 'warn';
  return 'info';
}

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
}

const MAX_LOGS = 500;
const logs: LogEntry[] = [];

export const status = {
  startedAt: Date.now(),
  wsConnected: false,
  acpConnected: false,
  qqOnline: false,
  selfId: 0,
  nickname: '',
  sessions: 0,
  messagesIn: 0,
  messagesOut: 0,
  messagesDropped: 0,
  pendingMessages: 0,
  turns: 0,
  lastError: '',
};

export function log(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  logs.push({ ts: Date.now(), level, message });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

export function recentLogs(after = 0): LogEntry[] {
  return logs.filter((entry) => entry.ts > after);
}

export function snapshotStatus() {
  return {
    ...status,
    uptimeMs: Date.now() - status.startedAt,
  };
}
