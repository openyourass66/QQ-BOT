export type MediaCacheEntry={name:string;size:number;mtime:number;owned:boolean};
export type StoredMediaCacheEntry=MediaCacheEntry&{lastUsed:number;state:'complete'|'reserved'|'stale';owner:string;seen:string;fileTag:string};
export type MediaCacheStatistics={files:number;bytes:number};
export type MediaCacheCursor={lastUsed:number;name:string};
export type MediaCacheRequest=
  |{action:'media-cache-recover'}
  |{action:'media-cache-scan-start';root:string;owner:string}
  |{action:'media-cache-scan-batch';owner:string;entries:MediaCacheEntry[]}
  |{action:'media-cache-scan-complete';owner:string}
  |{action:'media-cache-scan-abort';owner:string}
  |{action:'media-cache-read';name:string}
  |{action:'media-cache-statistics'}
  |{action:'media-cache-candidates';cutoff:number;limit:number;after?:MediaCacheCursor}
  |{action:'media-cache-reserve';name:string;size:number;limit:number;owner:string}
  |{action:'media-cache-stage';name:string;owner:string;fileTag:string}
  |{action:'media-cache-complete';name:string;owner:string;mtime:number;at:number}
  |{action:'media-cache-abort';name:string;owner:string}
  |{action:'media-cache-touch';name:string;at:number}
  |{action:'media-cache-forget';name:string};
export interface MediaCacheStore {call<T=unknown>(request:MediaCacheRequest):Promise<T>;}
export const MEDIA_CACHE_MAX_FILES=20000;
export const ownedMediaName=(name:string)=>/^[a-f0-9]{64}(?:-\d{2})?\.[a-z0-9]{1,10}$/i.test(name);
export const safeMediaName=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&name.length<=255&&!/[\x00-\x1f\\/:]/.test(name)&&!['.','..'].includes(name);
export const mediaCacheError=(code:string,message:string)=>Object.assign(new Error(message),{code:'DATABASE_MEDIA_'+code});
