import {performance} from 'node:perf_hooks';
import type {MediaReferenceStore} from '../storage/media-reference-types.js';

/** One bounded backfill step per idle opportunity; readiness survives restart in SQLite. */
export class MediaReferenceMaintenance {
  private running?:Promise<void>;private ready=new Set<MediaReferenceStore>();private cursor=0;private last=-Infinity;
  constructor(private stores:MediaReferenceStore[],private options:{busy:()=>boolean;stopping:()=>boolean;onFailure:(error:Error)=>void;now?:()=>number}){}
  tick():Promise<void>{
    if(this.running||this.options.stopping()||this.options.busy()||this.ready.size===this.stores.length)return Promise.resolve();
    const now=(this.options.now??(()=>performance.now()))();if(now-this.last<1000)return Promise.resolve();this.last=now;
    const candidates=this.stores.filter(store=>!this.ready.has(store)),store=candidates[this.cursor++%candidates.length];
    this.running=Promise.resolve().then(()=>store.call<{ready:boolean}>({action:'media-refs-backfill'})).then(result=>{if(result.ready)this.ready.add(store);}).catch(error=>this.options.onFailure(error)).finally(()=>{this.running=undefined;});return this.running;
  }
  async flush(){await this.running;}
}
