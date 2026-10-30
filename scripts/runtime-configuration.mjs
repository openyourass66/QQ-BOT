import {createHmac,randomBytes} from 'node:crypto';
import {lstat,readFile,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {runtimeFields,mergeRuntimeEnv,validateRuntimeEnv} from '../desktop/runtime-fields.mjs';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {protectEnvironmentText} from './credentials.mjs';
import {assertNoPendingRestore} from './app-paths.mjs';

const editable=new Set(['BOT_ONEBOT_MODE','BOT_CHAT_MODE','BOT_CHAT_MODEL','BOT_CHAT_BASE_URL','BOT_LEARNING_BASE_URL','BOT_LEARNING_MODEL','BOT_MEDIA_BASE_URL','ONEBOT_HTTP_URL','ONEBOT_WS_URL','BOT_SELF_ID','TURN_TIMEOUT_MS','QUEUE_PER_CONVERSATION','QUEUE_TOTAL','MAX_CONCURRENT_TURNS','INGRESS_PER_CONVERSATION','INGRESS_TOTAL','INGRESS_MAX_BYTES','BATCH_MAX_BYTES']);
const secretKeys=new Set(runtimeFields.filter(field=>field[4]==='secret').map(field=>field[1]));
const isSecret=key=>/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key);
export class ConfigurationError extends Error {constructor(message,statusCode=400){super(message);this.statusCode=statusCode;}}

export function configurationFields(text) {
  const env=parseEnv(text),secrets=Object.entries(env).filter(([key,value])=>isSecret(key)&&value).map(([,value])=>value);
  return runtimeFields.map(([group,key,label,fallback,kind])=>{
    const value=String(env[key]??fallback??'');
    if(kind==='secret'||isSecret(key))return {group,key,label,kind:'secret',configured:Boolean(value),editable:secretKeys.has(key)};
    let safe=value;
    for(const secret of secrets)safe=safe.split(secret).join('[已隐藏]');
    if(/URL$/.test(key)&&safe){try{const url=new URL(safe);url.username='';url.password='';for(const name of url.searchParams.keys())if(/token|key|secret|password/i.test(name))url.searchParams.set(name,'[已隐藏]');safe=url.href;}catch{safe='地址格式需要检查';}}
    const redacted=safe!==value&&safe.includes('[已隐藏]')||/URL$/.test(key)&&Boolean(value)&&(()=>{try{const url=new URL(value);return Boolean(url.username||url.password)||[...url.searchParams.keys()].some(name=>/token|key|secret|password/i.test(name));}catch{return true;}})();
    return {group,key,label,kind:kind||'text',value:safe,editable:editable.has(key)&&!redacted,redacted};
  });
}

/** 修订号对完整原文做 HMAC；浏览器无法借修订号猜测短密钥。 */
export class RuntimeConfiguration {
  #key=randomBytes(32);
  constructor(dataRoot,{protectedCredentials=false}={}){this.path=join(dataRoot,'.env');this.dataRoot=dataRoot;this.protectedCredentials=protectedCredentials;}
  async #raw(){
    const info=await lstat(this.path);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>262144)throw new ConfigurationError('连接配置文件不可读取',409);
    return readFile(this.path,'utf8');
  }
  #revision(text){return createHmac('sha256',this.#key).update(text).digest('hex');}
  async read(){const text=await this.#raw();return {revision:this.#revision(text),fields:configurationFields(text)};}
  async update({revision,values,secret}={}) {
    assertNoPendingRestore(this.dataRoot);
    if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw new ConfigurationError('请先读取最新配置');
    let changes;
    if(secret){
      const {name,operation,value}=secret;
      if(!secretKeys.has(name)||!['replace','clear'].includes(operation)||operation==='replace'&&(typeof value!=='string'||!value||value.length>4096)||operation==='clear'&&value!==undefined)throw new ConfigurationError('密钥更新格式无效');
      changes={[name]:operation==='clear'?'':value};
    }else{
      if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).length>editable.size)throw new ConfigurationError('请选择要保存的连接字段');
      for(const [key,value] of Object.entries(values)){
        if(!editable.has(key)||typeof value!=='string'||value.length>4096)throw new ConfigurationError('此连接字段不可通过网页修改');
        if(/URL$/.test(key)&&value){try{const url=new URL(value);if(url.username||url.password||[...url.searchParams.keys()].some(name=>/token|key|secret|password/i.test(name)))throw new Error();}catch{throw new ConfigurationError('地址应使用独立的密钥字段，不得包含账号或敏感参数');}}
      }
      changes=values;
    }
    const lease=await acquireDataResources([{path:this.path,label:'连接配置'}]);
    let temporary;
    try{
      const before=await this.#raw();
      if(this.#revision(before)!==revision)throw new ConfigurationError('配置已被其它页面或本机修改，请重新读取后核对；当前输入已保留。',409);
      if(!secret){const fields=configurationFields(before);if(Object.keys(changes).some(key=>!fields.find(field=>field.key===key)?.editable))throw new ConfigurationError('地址包含隐藏内容，请在本机修改该字段',409);}
      let next;
      try{next=mergeRuntimeEnv(before,changes);if(secret?.operation!=='clear')validateRuntimeEnv(next);}catch{throw new ConfigurationError('连接配置无效，请检查地址、模式与数值范围；原配置已保留。');}
      if(Buffer.byteLength(next)>262144)throw new ConfigurationError('连接配置过大');
      next=await protectEnvironmentText(this.dataRoot,next,before,{protectedMode:this.protectedCredentials});
      if(next!==before){
        temporary=this.path+'.'+randomBytes(12).toString('hex')+'.tmp';
        const file=await open(temporary,'wx',0o600);
        try{await file.writeFile(next);await file.sync();}finally{await file.close();}
        await rename(temporary,this.path);temporary=undefined;
      }
      return {revision:this.#revision(next),fields:configurationFields(next),restartRequired:next!==before};
    }finally{if(temporary)await unlink(temporary).catch(()=>{});lease.release();}
  }
}
