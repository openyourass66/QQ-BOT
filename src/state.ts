export type LogLevel = 'info' | 'warn' | 'error';

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
}
