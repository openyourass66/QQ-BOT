import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdir,lstat,readFile,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const derive=promisify(scrypt),cost={N:131072,r:8,p:1,maxmem:268435456};
const digest=value=>createHash('sha256').update(value).digest('hex');
export class AuthError extends Error {constructor(message,statusCode=401){super(message);this.statusCode=statusCode;}}
async function directory(path) {await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('管理凭据目录不能使用链接');}
const authPath=dataRoot=>join(dataRoot,'data/management/auth.json');
async function readState(dataRoot) {
  const path=authPath(dataRoot),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>8192)throw new Error('管理凭据文件无效');
  const state=JSON.parse(await readFile(path,'utf8'));
  if(state.formatVersion!==1||!/^[a-f0-9]{32}$/.test(state.revision))throw new Error('管理凭据版本无效');
  if(state.password) {if(!/^[a-f0-9]{32}$/.test(state.password.salt)||!/^[a-f0-9]{64}$/.test(state.password.hash))throw new Error('管理口令记录无效');}
  else if(!/^[a-f0-9]{64}$/.test(state.bootstrapHash)||!Number.isSafeInteger(state.bootstrapExpires))throw new Error('管理认领记录无效');
  return state;
}
async function writeState(dataRoot,state) {
  const temp=authPath(dataRoot)+'.'+randomBytes(8).toString('hex')+'.tmp';
  const handle=await open(temp,'wx',0o600);
  try {
    try{await handle.writeFile(JSON.stringify(state,null,2)+'\n');await handle.sync();}finally{await handle.close();}
    await rename(temp,authPath(dataRoot));
  } finally {await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function authLease(dataRoot) {const {acquireDataResources}=await import('../dist/core/resource-lock.js');return acquireDataResources([{path:authPath(dataRoot),label:'Web 管理凭据'}]);}

/** 本机初始化工具调用；只返回一次性认领码，原始口令不写入文件。 */
export async function initializeWebOwner(dataRoot,{reset=false,now=Date.now()}={}) {
  await directory(join(dataRoot,'data'));await directory(join(dataRoot,'data/management'));
  const lease=await authLease(dataRoot);
  try {
    const existing=await lstat(authPath(dataRoot)).catch(error=>{if(error.code==='ENOENT')return;throw error;});
    if(existing&&!reset)throw new Error('管理凭据已存在；需要撤销旧会话时显式执行 reset-auth');
    if(existing)await readState(dataRoot);
    const token=randomBytes(32).toString('base64url'),expiresAt=now+15*60000;
    await writeState(dataRoot,{formatVersion:1,revision:randomBytes(16).toString('hex'),bootstrapHash:digest(token),bootstrapExpires:expiresAt});
    return {token,expiresAt};
  }finally{lease.release();}
}

export class OwnerAuth {
  constructor(dataRoot,{clock=Date.now}={}) {this.dataRoot=dataRoot;this.clock=clock;this.sessions=new Map();this.rates=new Map();this.hashing=false;}
  async status() {const state=await readState(this.dataRoot);return {setupRequired:!state.password,claimExpired:!state.password&&this.clock()>state.bootstrapExpires};}
  limit(source) {
    const now=this.clock();let row=this.rates.get(source);
    if(!row||now-row.at>60000){row={at:now,count:0};this.rates.delete(source);this.rates.set(source,row);}
    if(this.rates.size>128)this.rates.delete(this.rates.keys().next().value);
    if(++row.count>5)throw new AuthError('尝试次数较多，请稍后再试',429);
  }
  async hash(password,salt) {
    if(this.hashing)throw new AuthError('正在验证另一个登录请求，请稍后重试',429);
    this.hashing=true;try{return await derive(password,Buffer.from(salt,'hex'),32,cost);}finally{this.hashing=false;}
  }
  passwordInput(value) {if(typeof value!=='string'||[...value].length<15||Buffer.byteLength(value)>1024)throw new AuthError('管理口令至少 15 个字符、最多 1024 字节，支持粘贴和密码管理器',400);}
  async claim({token,password},source) {
    this.limit(source);this.passwordInput(password);
    const initial=await readState(this.dataRoot);
    if(initial.password||typeof token!=='string'||token.length>128||this.clock()>initial.bootstrapExpires||!timingSafeEqual(Buffer.from(digest(token),'hex'),Buffer.from(initial.bootstrapHash,'hex')))throw new AuthError('认领码无效或已过期');
    const salt=randomBytes(16).toString('hex'),hash=(await this.hash(password,salt)).toString('hex');
    const lease=await authLease(this.dataRoot);
    try {
      const current=await readState(this.dataRoot);if(current.revision!==initial.revision||current.password||this.clock()>current.bootstrapExpires)throw new AuthError('认领状态已改变，请刷新',409);
      const next={formatVersion:1,revision:randomBytes(16).toString('hex'),password:{salt,hash}};
      await writeState(this.dataRoot,next);this.sessions.clear();return this.session(next.revision);
    }finally{lease.release();}
  }
  async login({password},source) {
    this.limit(source);
    if(typeof password!=='string'||Buffer.byteLength(password)>1024)throw new AuthError('口令无效');
    const state=await readState(this.dataRoot);if(!state.password)throw new AuthError('请先使用一次性认领码设置主人口令');
    const actual=await this.hash(password,state.password.salt);
    if(!timingSafeEqual(actual,Buffer.from(state.password.hash,'hex'))||(await readState(this.dataRoot)).revision!==state.revision)throw new AuthError('口令无效');
    return this.session(state.revision);
  }
  session(revision) {
    const now=this.clock();for(const [key,row] of this.sessions)if(now>row.expires||now-row.active>30*60000)this.sessions.delete(key);
    while(this.sessions.size>=16)this.sessions.delete(this.sessions.keys().next().value);
    const token=randomBytes(32).toString('base64url'),record={revision,csrf:randomBytes(32).toString('base64url'),created:now,active:now,expires:now+12*3600000};
    this.sessions.set(digest(token),record);return {token,...record};
  }
  async verify(token,{touch=true}={}) {
    if(typeof token!=='string'||token.length!==43)throw new AuthError('请登录管理控制台');
    const key=digest(token),record=this.sessions.get(key),now=this.clock();
    if(!record||now>record.expires||now-record.active>30*60000) {this.sessions.delete(key);throw new AuthError('登录已失效，请重新登录');}
    if((await readState(this.dataRoot)).revision!==record.revision){this.sessions.clear();throw new AuthError('管理凭据已变更，请重新登录');}
    if(touch)record.active=now;return {id:key,...record};
  }
  async csrf(token,value) {
    const session=await this.verify(token);
    if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(session.csrf)))throw new AuthError('请求校验失败，请刷新页面',403);
    return session;
  }
  logout(token) {if(typeof token==='string')this.sessions.delete(digest(token));}
}
