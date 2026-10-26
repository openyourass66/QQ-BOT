export type LogLevel = 'info' | 'warn' | 'error';

export const status = {
  startedAt: Date.now(),
  wsConnected: false,
  acpConnected: false,
  model: '',
  qqOnline: false,
  selfId: 0,
  nickname: '',
  sessions: 0,
  messagesIn: 0,
  messagesOut: 0,
  messagesDropped: 0,
  pendingMessages: 0,
  pendingIngress: 0,
  pendingIngressBytes: 0,
  ingressDropped: 0,
  noticesDropped: 0,
  turns: 0,
  lastError: '',
};

export function log(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
