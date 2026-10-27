import { socialTools } from '../qq/social-tools.js';
import { legacyTools } from '../qq/legacy-tools.js';

const qqTools = new Set([...socialTools,...legacyTools].map(tool => `mcp__qq__${tool.name}`));
export const name = 'whale-tool-policy';
export const inject = ['tools'];

export function nativeToolDenial(execution: {name:string;arguments?:unknown}): string | undefined {
  if(qqTools.has(execution.name))return;
  if(execution.name==='web_search')return;
  if(execution.name==='web_fetch') {
    const args=execution.arguments as {url?:unknown}|undefined;
    try {
      const url=new URL(String(args?.url));
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error();
      const host=url.hostname.toLowerCase();
      if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)||host==='[::1]'||host==='[::]'||host.startsWith('[fc')||host.startsWith('[fd')||host.startsWith('[fe80:'))throw new Error();
      return;
    }catch{return '网页读取只允许公开 HTTP(S) 地址，不能访问本机、局域网或带账号的地址';}
  }
  return '机器人运行模式仅开放受控 QQ 工具和原生网页搜索/读取；本地文件、命令及其它工具已关闭';
}

/** 全局单调守卫同时覆盖直接工具及嵌套分派，其他监听器不能将拒绝改为允许。 */
export function apply(ctx: {tools:{guard:(check:typeof nativeToolDenial)=>unknown}}): void {
  if(typeof ctx.tools.guard!=='function')throw new Error('模型运行组件不支持必需的工具边界，请使用已验证的受管版本');
  ctx.tools.guard(nativeToolDenial);
  const nonce=process.env.BOT_DSH_POLICY_NONCE;
  if(nonce&&/^[a-f0-9]{48}$/.test(nonce))process.stderr.write(`[whale-policy] ${nonce}\n`);
}
