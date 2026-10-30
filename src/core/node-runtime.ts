/** 应用数据库仅运行在已验证的 Node 版本；QQ 组件使用独立运行库。 */
export const APPLICATION_RUNTIME_REQUIREMENT='Node.js 22.20–22.x 或 24 及以上版本';

export function assertApplicationRuntime(version=process.versions.node):void {
  const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if(match){const major=Number(match[1]),minor=Number(match[2]);if(major===22&&minor>=20||major>=24)return;}
  throw Object.assign(new Error(`应用需要 ${APPLICATION_RUNTIME_REQUIREMENT}，请升级应用运行环境；QQ 组件使用其独立运行库。`),{code:'BOT_NODE_UNSUPPORTED'});
}
