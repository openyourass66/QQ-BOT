export type RuntimeFailure = {code:string;recoverable:boolean;message:string};
export function classifyRuntimeFailure(input: unknown): RuntimeFailure {
  const error=input as {code?:unknown;name?:unknown;message?:unknown}|undefined;
  const code=String(error?.code??''),message=String(error?.message??'');
  if(code==='ACCOUNT_CHANGED')return {code,recoverable:false,message:'QQ 登录账号已变化，请停止机器人并为新账号选择独立数据目录。'};
  if(['BOT_RESOURCE_LOCKED','DATABASE_REVISION_CONFLICT'].includes(code))return {code:'INSTANCE_CONFLICT',recoverable:false,message:'数据已被另一个实例使用，请关闭重复实例后重试。'};
  if(code==='ENOSPC'||/磁盘.*满|空间不足/i.test(message))return {code:'DISK_FULL',recoverable:false,message:'磁盘空间不足，请释放数据目录所在磁盘空间后重试。'};
  if(['DATABASE_INVALID','DATABASE_SCHEMA_NEWER','DATABASE_NOT_INITIALIZED','DATABASE_OPEN_FAILED','DATABASE_OPERATION_FAILED'].includes(code)||error?.name==='SyntaxError'||/损坏|数据版本|schema version|JSON.*invalid/i.test(message))return {code:'DATA_INVALID',recoverable:false,message:'配置或数据无法读取，请保留原文件并使用修复或恢复入口。'};
  if(/凭据|API Key|令牌.*拒绝|HTTP (401|403)|unauthorized|authentication/i.test(message))return {code:'CREDENTIALS_INVALID',recoverable:false,message:'模型或 QQ 凭据需要处理，请检查连接设置后手动重试。'};
  if(['ENOENT','EACCES','EPERM','MODULE_INIT_FAILED'].includes(code)||/配置格式|安装文件|编译失败|进程保护|工具策略|工具边界|不支持/.test(message))return {code:'CONFIGURATION_REQUIRED',recoverable:false,message:'运行组件或配置需要处理，请查看启动诊断并修复后重试。'};
  return {code:code||'PROCESS_EXITED',recoverable:true,message:'运行进程意外退出，正在等待受控恢复。'};
}
