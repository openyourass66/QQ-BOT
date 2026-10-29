export type LogLevel = 'info' | 'warn' | 'error';
const secrets=new Set<string>();
export function registerRuntimeSecret(value:string):void{if(value.length>=4)for(const part of [value,...value.split(/\r?\n/).filter(part=>part.length>=4)])secrets.add(part);}
for(const [key,value] of Object.entries(process.env))if(/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)&&value)registerRuntimeSecret(value);
export function redactRuntimeText(text:string):string{for(const secret of secrets)text=text.split(secret).join('[已隐藏]');return text;}
let lastError='';

export const status = {
  startedAt: Date.now(),
  wsConnected: false,
  acpConnected: false,
  nativeToolsRestricted: false,
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
  get lastError(){return lastError;},
  set lastError(value:string){lastError=redactRuntimeText(value);},
};

export function log(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${redactRuntimeText(message)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
