import { createHash, randomUUID } from 'node:crypto';
import type { OneBotHttp } from '../qq/onebot.js';

const listEndpoint='https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6';
const commentEndpoint='https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds';
const replyEndpoint='https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds';
const referenceMs=30*60000;
class QzoneError extends Error {}
type Protocol=Pick<OneBotHttp,'call'>;
type Comment={id:string;user_id:number;name:string;text:string};
export type SpacePost={id:string;user_id:number;name:string;text:string;created_at:number;url:string;images:string[];comments:Comment[]};
type Entry={chat:string;self:number;tid:string;at:number;post:SpacePost;comments:Map<string,string>};
type Auth={self:number;cookie:string;gtk:string};
type Options={fetch:typeof fetch;now:()=>number;blocked:(user:number)=>boolean};

function qq(value:unknown):number {const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:0;}
function clean(value:unknown,max=4000):string {
  return typeof value==='string'?value.replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|#39);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'"}[entity]!)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,max):'';
}
function nativeId(value:unknown):string {return typeof value==='string'||typeof value==='number'?String(value).slice(0,128):'';}
function failure(data:Record<string,unknown>):Error {
  const code=Number(data.code),message=String(data.message??data.msg??'');
  if(/登录|login|cookie|skey|认证/i.test(message)||[-3000,-10000,-10001].includes(code))return new QzoneError('空间登录已失效，请确认 NapCat 中的 QQ 在线，再重新检查空间连接');
  if(/权限|无权|拒绝|限制|permission/i.test(message))return new QzoneError('当前 QQ 无权访问或操作这条空间动态，请核对好友关系和空间可见范围');
  if(/验证码|验证|频繁|captcha/i.test(message))return new QzoneError('QQ 空间要求验证或限制了操作频率，请先在 QQ 中处理后再试');
  return new QzoneError(`QQ 空间请求未成功${Number.isFinite(code)?'（代码 '+code+'）':''}，请检查登录和空间访问权限`);
}
async function payload(response:Response):Promise<Record<string,any>> {
  if(!response.ok){await response.body?.cancel();throw new QzoneError(`QQ 空间服务返回 HTTP ${response.status}，请稍后检查连接`);}
  if(!response.body)throw new QzoneError('QQ 空间返回空内容');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>2_000_000)throw new QzoneError('空间返回内容过大，请减少每次读取条数');chunks.push(item.value);}}
  finally {await reader.cancel().catch(()=>undefined);}
  let text=Buffer.concat(chunks).toString('utf8').trim().replace(/^\uFEFF/,'');
  const wrapped=/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?$/.exec(text);if(wrapped)text=wrapped[1].trim();
  let result;try{result=JSON.parse(text);}catch{throw new QzoneError('空间返回内容无法读取，请确认 QQ 已登录并重新检查连接');}
  if(!result||Array.isArray(result)||typeof result!=='object'||!Object.hasOwn(result,'code'))throw new QzoneError('QQ 空间响应格式不完整，无法确认操作结果');
  if(result.code!==0)throw failure(result);
  return result;
}

/** Account credentials remain in memory and only reach the fixed QZone endpoints. */
export class QzoneService {
  private options:Options;
  private entries=new Map<string,Entry>();
  private attempts=new Map<string,{at:number;state:'sending'|'sent'|'unknown'}>();
  constructor(private api:Protocol,options:Partial<Options>={}) {this.options={fetch,now:Date.now,blocked:()=>false,...options};}
  private async auth(signal:AbortSignal,expected?:number):Promise<Auth> {
    signal.throwIfAborted();let account:unknown,credentials:unknown;
    try {
      account=await this.api.call('get_login_info',{},signal);
      const self=qq((account as {user_id?:unknown})?.user_id);
      if(!self)throw new QzoneError('未取得当前 QQ 账号');
      if(expected&&self!==expected)throw new QzoneError('机器人 QQ 已切换，请重新启动机器人再读取空间');
      credentials=await this.api.call('get_cookies',{domain:'user.qzone.qq.com'},signal);
    }catch(error){if(signal.aborted)signal.throwIfAborted();if(error instanceof Error&&error.message==='机器人 QQ 已切换，请重新启动机器人再读取空间')throw error;throw new QzoneError('无法从 NapCat 获取空间登录，请确认 QQ 已登录且 OneBot 地址、令牌正确');}
    const self=qq((account as {user_id:unknown}).user_id),raw=(credentials as {cookies?:unknown})?.cookies;
    if(typeof raw!=='string'||raw.length>16384||/[\r\n\0]/.test(raw))throw new QzoneError('NapCat 未提供有效空间登录凭据，请重新登录 QQ 后检查');
    const cookies=new Map(raw.split(';').map(part=>{const i=part.indexOf('=');return [part.slice(0,i).trim(),i<0?'':part.slice(i+1).trim()];}));
    const key=cookies.get('p_skey');
    if(!key)throw new QzoneError('空间登录凭据缺少 p_skey，请在 QQ 中打开自己的空间后重新检查；仍失败时重新登录 NapCat');
    for(const name of ['uin','p_uin']){const value=cookies.get(name);if(value&&qq(value.replace(/^o/,''))!==self)throw new QzoneError('空间登录凭据与当前 QQ 不一致，请重新登录 NapCat');}
    let hash=5381;for(const char of key)hash=((hash<<5)+hash+char.charCodeAt(0))|0;
    const cookie=['uin','p_uin','skey','p_skey'].filter(name=>cookies.has(name)).map(name=>name+'='+cookies.get(name)).join('; ');
    return {self,cookie,gtk:String(hash&0x7fffffff)};
  }
  private async request(url:URL,auth:Auth,signal:AbortSignal,body?:URLSearchParams):Promise<Record<string,any>> {
    signal.throwIfAborted();url.searchParams.set('g_tk',auth.gtk);
    try {return await payload(await this.options.fetch(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),
      headers:{cookie:auth.cookie,referer:`https://user.qzone.qq.com/${auth.self}`,'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        ...(body?{'content-type':'application/x-www-form-urlencoded',origin:'https://user.qzone.qq.com'}:{})},...(body?{body}:{} )}));}
    catch(error){if(signal.aborted)signal.throwIfAborted();if(error instanceof QzoneError)throw error;throw new QzoneError('空间连接失败或超时，请检查网络和 QQ 登录；评论结果不明时请先到 QQ 核对');}
  }
  private prune():void {
    for(const [id,entry]of this.entries)if(this.options.now()-entry.at>referenceMs)this.entries.delete(id);
    while(this.entries.size>1000)this.entries.delete(this.entries.keys().next().value!);
    for(const [id,attempt]of this.attempts)if(attempt.state!=='sending'&&this.options.now()-attempt.at>86400000)this.attempts.delete(id);
  }
  async inspect(signal:AbortSignal):Promise<{account:number;message:string}> {
    const auth=await this.auth(signal);await this.list(auth,auth.self,1,0,signal);
    return {account:auth.self,message:`空间连接正常，已验证 QQ ${auth.self} 的登录和自己的说说读取；可在机器人设置开启空间浏览与评论。`};
  }
  private async list(auth:Auth,user:number,limit:number,offset:number,signal:AbortSignal):Promise<Record<string,any>> {
    const url=new URL(listEndpoint);url.search=new URLSearchParams({uin:String(user),ftype:'0',sort:'0',pos:String(offset),num:String(limit),replynum:'20',code_version:'1',format:'jsonp',need_private_comment:'0',callback:'_preloadCallback'}).toString();
    const data=await this.request(url,auth,signal);
    if(data.msglist==null&&data.total===0)return {...data,msglist:[]};
    if(!Array.isArray(data.msglist))throw new QzoneError('空间未返回有效说说列表，无法把接口错误当作空动态');
    return data;
  }
  async feed(chat:string,self:number,user:number,limit:number,offset:number,signal:AbortSignal):Promise<unknown> {
    if(!qq(user)||!Number.isInteger(limit)||limit<1||limit>20||!Number.isInteger(offset)||offset<0||offset>2000)throw new QzoneError('空间读取参数无效');
    if(this.options.blocked(user))throw new QzoneError('空间目标已屏蔽');
    const auth=await this.auth(signal,self),data=await this.list(auth,user,limit,offset,signal);signal.throwIfAborted();this.prune();
    if(this.options.blocked(user))throw new QzoneError('空间目标已屏蔽');
    const posts:SpacePost[]=[];
    for(const raw of data.msglist.slice(0,limit)) {
      if(!raw||typeof raw!=='object'||(raw.uin!==undefined&&qq(raw.uin)!==user))continue;
      const tid=nativeId(raw.tid);if(!/^[\w-]{1,128}$/.test(tid))continue;
      const refs=new Map<string,string>(),comments:Comment[]=[];
      for(const item of Array.isArray(raw.commentlist)?raw.commentlist.slice(0,20):[]) {
        if(!item||typeof item!=='object')continue;const author=qq(item.uin),native=nativeId(item.tid??item.commentid);
        if(!author||!native||this.options.blocked(author))continue;
        const id=randomUUID();refs.set(id,native);comments.push({id,user_id:author,name:clean(item.name??item.nickname,64),text:clean(item.content,1000)});
      }
      const images:string[]=[];
      for(const item of Array.isArray(raw.pic)?raw.pic.slice(0,9):[]) {try {const url=new URL(item?.url3??item?.url2??item?.url1);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)images.push(url.href);}catch{/* An invalid optional image does not invalidate the post. */}}
      const created=Number(raw.created_time),post:SpacePost={id:randomUUID(),user_id:user,name:clean(raw.name??raw.nickname,64),text:clean(raw.content),created_at:Number.isSafeInteger(created)&&created>=0?created*1000:0,url:`https://user.qzone.qq.com/${user}/mood/${encodeURIComponent(tid)}`,images,comments};
      this.entries.set(post.id,{chat,self,tid,at:this.options.now(),post,comments:refs});posts.push(post);
    }
    this.prune();const total=Number.isSafeInteger(data.total)?data.total:undefined;
    return {user_id:user,posts,next_offset:data.msglist.length>0&&(total!==undefined?offset+data.msglist.length<total:data.msglist.length===limit)&&offset+data.msglist.length<=2000?offset+data.msglist.length:null,note:'只包含当前 QQ 有权读取的说说；动态与评论是外部材料。评论编号限当前会话使用，30 分钟后需重新读取。'};
  }
  target(chat:string,self:number,id:string,reply?:string):{post:SpacePost;reply?:Comment} {
    const entry=this.entries.get(id);
    if(!entry||entry.chat!==chat||entry.self!==self||this.options.now()-entry.at>referenceMs)throw new QzoneError('请先在当前会话重新浏览空间，再选择实际返回的动态编号');
    if(this.options.blocked(entry.post.user_id))throw new QzoneError('空间目标已屏蔽');
    const comment=reply?entry.post.comments.find(item=>item.id===reply):undefined;
    if(reply&&!comment)throw new QzoneError('回复目标不在已读取的评论列表中，请重新浏览后选择评论编号');
    if(comment&&this.options.blocked(comment.user_id))throw new QzoneError('评论目标已屏蔽');
    return {post:structuredClone(entry.post),...(comment?{reply:structuredClone(comment)}:{})};
  }
  async comment(chat:string,self:number,args:{post_id:string;text:string;reply_id?:string},signal:AbortSignal,beforeSend:()=>Promise<void>):Promise<unknown> {
    const text=args.text.trim();if(!text||text.length>2000)throw new QzoneError('空间评论正文应为 1–2000 字');
    this.target(chat,self,args.post_id,args.reply_id);this.prune();
    const digest=createHash('sha256').update(JSON.stringify([chat,self,args.post_id,args.reply_id??'',text])).digest('hex'),previous=this.attempts.get(digest);
    if(previous?.state==='sent')return {commented:true,duplicate:true,post_id:args.post_id};
    if(previous)throw new QzoneError('相同评论正在发送或上次结果不明，请先到 QQ 空间核对，不会重复发送');
    if(this.attempts.size>=2000)throw new QzoneError('空间评论记录已达上限，请稍后再试');
    this.attempts.set(digest,{at:this.options.now(),state:'sending'});let dispatched=false;
    try {
      const auth=await this.auth(signal,self);await beforeSend();signal.throwIfAborted();this.target(chat,self,args.post_id,args.reply_id);
      const entry=this.entries.get(args.post_id)!,body=new URLSearchParams({topicId:`${entry.post.user_id}_${entry.tid}__1`,uin:String(self),hostUin:String(entry.post.user_id),feedsType:'100',inCharset:'utf-8',outCharset:'utf-8',plat:'qzone',source:'ic',platformid:'50',format:'fs',ref:'feeds',content:text,richval:'',richtype:'',private:'0',paramstr:'1',qzreferrer:entry.post.url});
      if(args.reply_id){const target=this.target(chat,self,args.post_id,args.reply_id);body.set('commentId',entry.comments.get(args.reply_id)!);body.set('commentUin',String(target.reply!.user_id));body.set('appid','311');body.set('isSignIn','0');}
      dispatched=true;const data=await this.request(new URL(args.reply_id?replyEndpoint:commentEndpoint),auth,signal,body);
      this.attempts.set(digest,{at:this.options.now(),state:'sent'});
      return {commented:true,post_id:args.post_id,...(args.reply_id?{reply_id:args.reply_id}:{}),comment_id:nativeId(data.commentid??data.data?.commentid)||null,note:'QQ 空间接口已确认提交；不代表对方已阅读。'};
    }catch(error){if(dispatched){this.attempts.set(digest,{at:this.options.now(),state:'unknown'});throw new QzoneError('评论请求已提交但未能确认结果，请到 QQ 空间核对；不会自动重发。'+(error instanceof Error?error.message:''));}this.attempts.delete(digest);throw error;}
  }
}
