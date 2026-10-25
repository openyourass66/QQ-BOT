import { createHash, randomUUID } from 'node:crypto';
import { SocialStore, type SocialData } from './social-store.js';
import { MediaService, imageMime } from './media.js';
import type { OneBotHttp } from './onebot.js';

type Favorite = NonNullable<SocialData['stickers'][number]['qq']>;
const md5Of = (buffer: Buffer) => createHash('md5').update(buffer).digest('hex');
function favorites(raw: unknown): Favorite[] {
  if (!Array.isArray(raw)) throw new Error('QQ 收藏列表格式异常，未使用本地图库冒充 QQ 收藏');
  return raw.map(item => {
    if (!item || typeof item !== 'object' || typeof item.resId !== 'string' || !item.resId || !/^[a-f0-9]{32}$/i.test(item.md5 ?? '')) throw new Error('QQ 收藏详情缺少有效资源编号或 MD5');
    return { resId:item.resId,emojiId:String(item.emoId ?? item.emojiId ?? item.eId ?? ''),md5:item.md5.toLowerCase(),url:typeof item.url==='string'?item.url:'',cachePath:typeof item.emoOriginalPath==='string'&&item.emoOriginalPath?item.emoOriginalPath:typeof item.emoPath==='string'?item.emoPath:'',description:typeof item.desc==='string'?item.desc:'' };
  });
}
function nativeSuccess(result: unknown): void {
  if (result && typeof result === 'object' && 'result' in result && Number(result.result) !== 0) throw new Error('QQ 收藏操作失败：' + String('errMsg' in result ? result.errMsg : result.result));
}

/** QQ 收藏是数据源；本地仅保留图片缓存和理解记录。 */
export class QqStickers {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: SocialStore, private readonly media: MediaService, private readonly api: OneBotHttp) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(run); this.chain = next.catch(() => undefined); return next;
  }
  private async account(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const info = await this.api.call<{user_id:number}>('get_login_info',{},signal);
    if (!Number.isSafeInteger(info?.user_id) || info.user_id<=0) throw new Error('无法核验当前 QQ 收藏所属账号');
    await this.store.account(info.user_id);
  }
  private async syncNow(signal: AbortSignal): Promise<Favorite[]> {
    const list = favorites(await this.api.call('fetch_custom_face_detail',{count:2000},signal));
    const snapshot = this.store.snapshot(), hashes = new Map<string,string>();
    for (const item of snapshot.stickers) {
      if (item.md5 || item.qq?.md5 || !item.file) continue;
      try { hashes.set(item.id,md5Of((await this.media.bytes(item.file,signal)).buffer)); }
      catch { signal.throwIfAborted(); /* Retain unavailable legacy caches for explicit repair. */ }
    }
    const next = structuredClone(snapshot.stickers), seen = new Set<string>();
    for (const item of next) if (hashes.has(item.id)) item.md5=hashes.get(item.id);
    for (const favorite of list) {
      let item=next.find(s=>s.qq?.resId===favorite.resId || (s.md5 ?? s.qq?.md5)===favorite.md5);
      if (!item) { item={id:randomUUID(),file:'',note:favorite.description||'QQ 收藏表情',tags:[],uses:0,at:Date.now(),qqPresent:true};next.push(item); }
      if(item.md5&&item.md5!==favorite.md5){item.file='';delete item.analysis;}
      item.qq=favorite;item.md5=favorite.md5;item.qqPresent=true;seen.add(item.id);
    }
    // A full page may be truncated; only a complete list can prove removals.
    if (list.length<2000) for (const item of next) if (item.qq && !seen.has(item.id)) item.qqPresent=false;
    if (JSON.stringify(next)!==JSON.stringify(snapshot.stickers)) await this.store.update(d=>{
      // Preserve analysis/notes changed while the network request was running.
      for (const remote of next) {
        const current=d.stickers.find(s=>s.id===remote.id);
        if (current) { if(current.md5&&remote.md5&&current.md5!==remote.md5){current.file='';delete current.analysis;}current.qq=remote.qq;current.qqPresent=remote.qqPresent;if(remote.md5)current.md5=remote.md5; }
        else if(remote.qqPresent)d.stickers.push(remote);
      }
    });
    return list;
  }
  sync(signal: AbortSignal): Promise<Favorite[]> { return this.serial(async()=>{await this.account(signal);return this.syncNow(signal);}); }
  collect(file: string, signal: AbortSignal, reserve: () => Promise<void> = async()=>{}): Promise<SocialData['stickers'][number]> {
    return this.serial(async()=>{
      await this.account(signal);
      const {buffer}=await this.media.bytes(file,signal);imageMime(buffer);const md5=md5Of(buffer);
      let list=await this.syncNow(signal),favorite=list.find(f=>f.md5===md5);
      if (!favorite) {
        if (!this.api.hasLocalMedia) throw new Error('当前 QQ 协议端在远程，需先配置共享文件或上传通道，不能将本地缓存当作 QQ 收藏成功');
        await reserve();signal.throwIfAborted();
        let failure: unknown;
        try { nativeSuccess(await this.api.call('add_custom_face',{file,is_origin:true},signal)); }
        catch(error) { signal.throwIfAborted();failure=error; }
        for(let attempt=0;attempt<6;attempt++) {
          list=await this.syncNow(signal);favorite=list.find(f=>f.md5===md5);if(favorite)break;
          if(attempt<5)await new Promise<void>((done,reject)=>{const timer=setTimeout(finish,200);function finish(){signal.removeEventListener('abort',cancel);done();}function cancel(){clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);}signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
        }
        if (!favorite) throw failure ?? new Error('QQ 尚未回读到这张收藏，结果待核对；没有把本地保存显示为 QQ 收藏成功');
      }
      return this.store.update(d=>{
        const item=d.stickers.find(s=>s.qqPresent&&s.qq?.md5===md5);if(!item)throw new Error('QQ 收藏记录尚未同步，请刷新后核对');
        item.file=file;item.md5=md5;return item;
      });
    });
  }
  async collectLegacy(id: string, signal: AbortSignal): Promise<void> {
    const item=this.store.snapshot().stickers.find(s=>s.id===id);if(!item?.file)throw new Error('本地表情缓存不存在，无法补入 QQ 收藏');
    await this.collect(item.file,signal);
  }
  async image(id: string, signal: AbortSignal): Promise<{type:'image';data:string;mimeType:string}> {
    await this.sync(signal);
    const item=this.store.snapshot().stickers.find(s=>s.id===id);
    if(!item?.qqPresent||!item.qq)throw new Error('这张表情当前不在 QQ 收藏中，请先收藏或刷新 QQ 列表');
    if(item.file) {
      try {
        const image=await this.media.image(item.file,signal);
        if(md5Of(Buffer.from(image.data,'base64'))!==item.qq.md5)throw new Error('表情缓存与 QQ 收藏不一致，请重新获取原图');
        return image;
      } catch(error) { signal.throwIfAborted();if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
    }
    let image: {type:'image';data:string;mimeType:string};
    try { image=await this.media.onebotImage({file:item.qq.cachePath,url:item.qq.url},signal,this.api.hasLocalMedia); }
    catch(error) {
      signal.throwIfAborted();if(!this.api.hasLocalMedia||!/^https?:\/\//i.test(item.qq.url))throw error;
      const download=await this.api.call<{file?:string}>('download_file',{url:item.qq.url,thread_count:1},signal);
      image=await this.media.onebotImage(download,signal,true);
    }
    const buffer=Buffer.from(image.data,'base64');if(md5Of(buffer)!==item.qq.md5)throw new Error('下载的表情与 QQ 收藏 MD5 不一致');
    const cached=await this.media.save(buffer,'.'+image.mimeType.split('/')[1]);
    await this.store.update(d=>{const current=d.stickers.find(s=>s.id===id);if(current&&current.qq?.md5===item.qq!.md5)current.file=cached;});
    return image;
  }
  remove(id: string, signal: AbortSignal): Promise<void> {
    return this.serial(async()=>{
      await this.account(signal);let list=await this.syncNow(signal);
      const item=this.store.snapshot().stickers.find(s=>s.id===id);if(!item)throw new Error('表情不存在');
      const favorite=list.find(f=>f.resId===item.qq?.resId||f.md5===(item.md5??item.qq?.md5));if(!favorite)return;
      nativeSuccess(await this.api.call('delete_custom_face',{res_id:favorite.resId},signal));
      for(let attempt=0;attempt<5;attempt++){list=await this.syncNow(signal);if(!list.some(f=>f.md5===favorite.md5))return;await new Promise(r=>setTimeout(r,150));signal.throwIfAborted();}
      throw new Error('QQ 收藏列表仍包含这张表情，尚未确认移除成功');
    });
  }
}
