export type MediaReferenceStatus={ready:boolean;references:number};
export type MediaReferenceQuery=MediaReferenceStatus&{names:string[]};
export const MEDIA_REFERENCE_LIMITS={perRecord:256,total:1_000_000,query:100,batch:64,bytes:524288,milliseconds:12};
export type MediaReferenceRequest=
  |{action:'media-refs-status'}
  |{action:'media-refs-backfill'}
  |{action:'media-refs-query';names:string[]}
  |{action:'media-refs-pin';name:string;operationId:string;owner:string};
export interface MediaReferenceStore {call<T=unknown>(request:MediaReferenceRequest):Promise<T>;}

/** Filename matches are conservative: a matching mention also protects a cache entry. */
export function mediaNames(payload:string):string[]{
  const found=new Set<string>();
  for(const match of payload.matchAll(/(?<![a-z0-9])[a-f0-9]{64}(?:-\d{2})?\.[a-z0-9]{1,10}(?![a-z0-9])/gi)){
    found.add(match[0].toLowerCase());if(found.size>MEDIA_REFERENCE_LIMITS.perRecord)throw Object.assign(new Error('单条记录的媒体引用超过支持上限，本次未写入'),{code:'DATABASE_STATE_LIMIT'});
  }
  return [...found];
}
