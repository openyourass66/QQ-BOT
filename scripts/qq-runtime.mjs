import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir, lstat, readdir, unlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { installedComponent, napcatShellDirectory } from './component-paths.mjs';
import { sameRuntimePath } from './app-paths.mjs';

const allowedCalls = new Set(['/QQLogin/CheckLoginStatus','/QQLogin/GetQQLoginInfo','/QQLogin/RefreshQRcode','/OB11Config/GetConfig']);
const validPort = value => Number.isInteger(value) && value > 1024 && value <= 65535;
async function jsonFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw new Error('QQ 受管配置不是有效的普通文件');
  return JSON.parse(await readFile(path,'utf8'));
}
async function privateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('QQ 受管目录不能使用链接');
}
async function freePorts(count,preferred=[]) {
  const servers=[];
  try {
    for(let i=0;i<count;i++) {
      const server=createServer();servers.push(server);
      await new Promise((done,reject)=>{server.once('error',reject);server.listen(preferred[i]||0,'127.0.0.1',done);});
    }
    return servers.map(server=>server.address().port);
  } finally { await Promise.all(servers.map(server=>new Promise(done=>server.close(done)))); }
}

export function matchesManagedNetwork(config, metadata) {
  const network=config?.network;
  if(!network)return false;
  const http=network.httpServers?.filter(row=>row.enable),ws=network.websocketServers?.filter(row=>row.enable);
  const common=row=>row?.host==='127.0.0.1' && row.token===metadata.token && row.messagePostFormat==='array';
  return http?.length===1 && ws?.length===1 && common(http[0]) && common(ws[0]) && http[0].port===metadata.httpPort && ws[0].port===metadata.wsPort &&
    ['httpClients','httpSseServers','websocketClients','plugins'].every(key=>!network[key]?.some(row=>row.enable));
}

/** 固定版本的本机登录适配器；凭据及二维码只留在内存，不进入工作日志。 */
export class ManagedQQ {
  constructor({root,dataRoot,fetcher=fetch,encodeQr}={}) {this.root=root;this.dataRoot=dataRoot;this.fetcher=fetcher;this.encodeQr=encodeQr;this.auth=undefined;this.qr=undefined;}
  get runtime() {return join(this.dataRoot,'napcat/node-runtime');}
  async selected(shell) {
    const managed=await installedComponent('napcat',this.dataRoot,this.root);
    if(!managed || managed.spec.version!=='4.18.41')throw new Error('请先准备支持的 QQ 组件');
    if(shell && !await sameRuntimePath(resolve(this.dataRoot,shell),napcatShellDirectory(managed)))throw new Error('当前选择的是自定义 QQ 组件，请使用高级连接配置，或选择已准备的组件');
    return managed;
  }
  async metadata() {
    const value=await jsonFile(join(this.runtime,'managed-connection.json'));
    if(value.formatVersion!==1 || ![value.httpPort,value.wsPort,value.webuiPort].every(validPort) || new Set([value.httpPort,value.wsPort,value.webuiPort]).size!==3 || !/^[a-f0-9]{64}$/.test(value.token))throw new Error('QQ 受管连接记录无效，请保留配置并修复');
    return value;
  }
  async loginConfiguration() {
    let metadata;
    try {metadata=await this.metadata();}catch(error){if(error.code!=='ENOENT')throw error;}
    const config=await jsonFile(join(this.runtime,'config/webui.json'));
    const localHosts=['127.0.0.1','localhost','::1','0.0.0.0','::'];
    if(!validPort(config.port) || typeof config.token!=='string' || !config.token || config.token.length>8192 || config.enable2FA ||
      (metadata ? config.host!=='127.0.0.1' || config.port!==metadata.webuiPort || config.token.length<24 : !localHosts.includes(config.host)))throw new Error('QQ 管理端配置已改变，请检查本机 WebUI 配置');
    return {metadata,config};
  }
  async existingConfiguration() {
    try {return !(await this.loginConfiguration()).metadata;}catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  suggestions(metadata,managed) {
    return {BOT_ONEBOT_MODE:'managed',BOT_NAPCAT_DIR:napcatShellDirectory(managed),ONEBOT_HTTP_URL:`http://127.0.0.1:${metadata.httpPort}`,ONEBOT_WS_URL:`ws://127.0.0.1:${metadata.wsPort}`,ONEBOT_TOKEN:metadata.token};
  }
  async connection(shell) {
    const managed=await this.selected(shell),metadata=await this.metadata();
    if(!matchesManagedNetwork(await jsonFile(join(this.runtime,'config/onebot11.json')),metadata))throw new Error('受管连接已改变，请核对高级配置');
    return {operation:'connection',suggestions:this.suggestions(metadata,managed)};
  }
  async recoverPreparation() {
    const pending=join(this.runtime,'managed-connection.pending.json');
    let record;try{record=await jsonFile(pending);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(await lstat(join(this.runtime,'managed-connection.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('QQ 准备记录与正式配置同时存在，已保留文件供核对');
    const names=['config/onebot11.json','config/webui.json'];
    if(record.formatVersion!==1 || Object.keys(record.files||{}).sort().join()!==names.sort().join() || names.some(name=>!/^[a-f0-9]{64}$/.test(record.files[name])))throw new Error('QQ 准备记录无效，已保留文件供修复');
    const owned=[];
    for(const name of names) {
      const path=join(this.runtime,name);
      try {await jsonFile(path);if(createHash('sha256').update(await readFile(path)).digest('hex')!==record.files[name])throw new Error('中断的 QQ 配置已有新修改，已保留文件，请检查高级配置');owned.push(path);}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    for(const path of owned)await unlink(path);
    await unlink(pending);
  }
  async prepare(shell) {
    const managed=await this.selected(shell);
    const {acquireDataResources}=await import('../dist/core/resource-lock.js');
    const {dataPaths,mutableDataResources}=await import('../dist/core/data-paths.js');
    const text=await readFile(join(this.dataRoot,'.env'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    const lease=await acquireDataResources([...mutableDataResources(dataPaths({...process.env,...parseEnv(text)},this.dataRoot)),{path:join(this.dataRoot,'components'),label:'QQ 组件配置'}]);
    try {
      await privateDirectory(join(this.dataRoot,'napcat'));await privateDirectory(this.runtime);await privateDirectory(join(this.runtime,'config'));
      await this.recoverPreparation();
      let metadata;
      try { metadata=await this.metadata(); }
      catch(error) {
        if(error.code!=='ENOENT')throw error;
        const existing=await readdir(join(this.runtime,'config'));
        if(existing.some(name=>/^onebot11(?:_|\.)|^webui\.json$/i.test(name)))throw new Error('已有手工 QQ 配置保持不变，请沿用高级连接方式；自动准备仅用于新的受管配置');
        const [httpPort,wsPort,webuiPort]=await freePorts(3);
        metadata={formatVersion:1,httpPort,wsPort,webuiPort,token:randomBytes(32).toString('hex')};
        const common={enable:true,host:'127.0.0.1',messagePostFormat:'array',token:metadata.token,debug:false};
        const config={network:{httpServers:[{...common,name:'whale-http',port:httpPort,enableCors:false,enableWebsocket:false}],websocketServers:[{...common,name:'whale-ws',port:wsPort,reportSelfMessage:false,enableForcePushEvent:true,heartInterval:30000}],httpSseServers:[],httpClients:[],websocketClients:[],plugins:[]},musicSignUrl:'',enableLocalFile2Url:false,parseMultMsg:false};
        const files=[['config/onebot11.json',config],['config/webui.json',{host:'127.0.0.1',port:webuiPort,token:randomBytes(32).toString('hex'),loginRate:3}]].map(([name,value])=>[name,JSON.stringify(value,null,2)+'\n']);
        metadata.files=Object.fromEntries(files.map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]));
        const created=[];
        try {
          const pending=join(this.runtime,'managed-connection.pending.json');await writeFile(pending,JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});created.push(pending);
          for(const [name,text] of files){const path=join(this.runtime,name);await writeFile(path,text,{flag:'wx',mode:0o600});created.push(path);}
          await rename(pending,join(this.runtime,'managed-connection.json'));
        }
        catch(error){for(const path of created.reverse())await unlink(path);throw error;}
      }
      const config=await jsonFile(join(this.runtime,'config/onebot11.json'));
      if(!matchesManagedNetwork(config,metadata))throw new Error('受管 OneBot 配置已改变，请检查高级配置；本次不会覆盖');
      try {await freePorts(3,[metadata.httpPort,metadata.wsPort,metadata.webuiPort]);}
      catch {throw new Error('QQ 受管端口已被占用，请先停止同一实例的 QQ，或检查端口冲突');}
      return {operation:'prepare',phase:'starting',managed:true,suggestions:this.suggestions(metadata,managed)};
    } finally {lease.release();}
  }
  async request(path,body={},retry=true) {
    if(!allowedCalls.has(path))throw new Error('不支持的 QQ 管理操作');
    const {config}=await this.loginConfiguration();
    const host=config.host==='::1'?'[::1]':'127.0.0.1';
    const key=createHash('sha256').update(config.token).digest('hex')+':'+host+':'+config.port;
    const post=async (route,value,credential)=>{
      let response;
      try {response=await this.fetcher(`http://${host}:${config.port}/api${route}`,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(2500)});}
      catch {throw Object.assign(new Error('QQ 管理端暂未就绪，请稍候或检查启动日志'),{code:'QQ_WEBUI_NOT_READY'});}
      const {readJsonLimited}=await import('../dist/services/read-json.js');
      let json;try{json=await readJsonLimited(response,65536);}catch{throw new Error('QQ 管理端响应无效或过大');}
      if(!response.ok || json?.code!==0) {
        const error=new Error('QQ 管理端拒绝请求，请检查登录状态与受管配置');
        error.unauthorized=/Unauthorized|Authorization Failed|Token has been revoked/i.test(json?.message||'');throw error;
      }
      return json.data;
    };
    if(!this.auth || this.auth.key!==key || this.auth.expires<Date.now()) {
      const hash=createHash('sha256').update(config.token+'.napcat').digest('hex');
      const data=await post('/auth/login',{hash});
      if(typeof data?.Credential!=='string' || data.Credential.length>8192 || data.require2FA)throw new Error('QQ 管理端需要额外认证，请使用本机 WebUI 完成');
      this.auth={key,credential:data.Credential,expires:Date.now()+50*60000};
    }
    try {return await post(path,body,this.auth.credential);}
    catch(error){if(retry&&error.unauthorized){this.auth=undefined;return this.request(path,body,false);}throw error;}
  }
  async status({refresh=false,mode}={}) {
    if(mode==='external')return {operation:'status',phase:'external',managed:false,message:'当前连接外部 QQ 服务，请在原服务中完成 QQ 登录。'};
    let metadata;
    try {({metadata}=await this.loginConfiguration());}catch(error){if(error.code!=='ENOENT')throw error;await this.selected();return {operation:'status',phase:'setup_required',managed:true,message:'点击自动配置并登录 QQ，创建本机安全连接。'};}
    if(refresh) {await this.request('/QQLogin/RefreshQRcode');this.qr=undefined;}
    let data;
    try {data=await this.request('/QQLogin/CheckLoginStatus');}catch(error){if(metadata||error.code!=='QQ_WEBUI_NOT_READY')throw error;return {operation:'status',phase:'stopped',managed:false,message:'现有 QQ 服务尚未启动。点击“启动现有 QQ”，沿用已有配置登录。'};}
    if(!data || typeof data.isLogin!=='boolean' || typeof data.loginPhase!=='string')throw new Error('QQ 登录状态格式不受支持');
    const phase=data.coreReady===true&&data.isLogin?'ready':data.isOffline?'offline':['initializing','qrcode_scanned','generating_qrcode','waiting_qrcode','reconnecting','offline'].includes(data.loginPhase)?data.loginPhase:'needs_attention';
    const result={operation:'status',phase,managed:!!metadata,online:phase==='ready',networkReady:false,message:phase==='ready'?'QQ 已登录，正在核对消息连接。':phase==='qrcode_scanned'?'已扫码，请在手机 QQ 确认。':phase==='initializing'?'QQ 正在初始化，请稍候。':phase==='offline'?'QQ 已离线，可刷新二维码重新登录。':phase==='needs_attention'?'QQ 需要额外验证，请查看本机 WebUI 或启动日志。':'请使用手机 QQ 扫码，勿分享二维码。'};
    if(data.loginError){result.phase='needs_attention';result.message='QQ 返回登录错误或额外验证要求，请按官方流程处理后重试。';}
    if(phase==='ready') {
      this.qr=undefined;
      const account=await this.request('/QQLogin/GetQQLoginInfo');
      if(/^\d{5,20}$/.test(String(account?.uin||'')))result.account=String(account.uin);
      if(metadata){result.networkReady=matchesManagedNetwork(await this.request('/OB11Config/GetConfig'),metadata);result.message=result.networkReady?'QQ 已登录，本机安全连接已配置。请保存草稿并检查启动。':'QQ 已登录，但 OneBot 配置与受管连接不一致，请检查高级配置。';}
      else result.message='QQ 已登录，继续使用现有 OneBot 连接配置；消息连接以工作总览为准。';
    } else if(['waiting_qrcode','offline'].includes(phase) && typeof data.qrcodeurl==='string' && data.qrcodeurl.length<=4096 && data.qrcodeurl) {
      let url;try{url=new URL(data.qrcodeurl);}catch{}
      if(url?.protocol!=='https:' || !(url.hostname==='qq.com'||url.hostname.endsWith('.qq.com')) || url.username || url.password)throw new Error('QQ 返回了非官方登录二维码地址，已拒绝显示');
      if(this.qr?.value!==data.qrcodeurl) {
        const encode=this.encodeQr || (async value=>{const {default:qrcode}=await import('qrcode');return qrcode.toDataURL(value,{width:256,margin:2,errorCorrectionLevel:'M'});});
        this.qr={value:data.qrcodeurl,image:await encode(data.qrcodeurl)};
      }
      result.qrImage=this.qr.image;
    }
    return result;
  }
}
