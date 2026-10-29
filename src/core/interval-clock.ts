import {performance} from 'node:perf_hooks';

type Anchor={stamp:number;mono:number;age:number};
/** Persist wall timestamps; measure an observed interval with a monotonic clock. */
export class IntervalClock {
  private anchors=new Map<string,Anchor>();
  constructor(private wall:()=>number=Date.now,private monotonic:()=>number=()=>performance.now(),private capacity=10000){if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('间隔时钟容量无效');}
  private set(key:string,anchor:Anchor){this.anchors.delete(key);this.anchors.set(key,anchor);if(this.anchors.size>this.capacity)this.anchors.delete(this.anchors.keys().next().value!);}
  mark(key:string,stamp:number):void{this.set(key,{stamp,mono:this.monotonic(),age:0});}
  due(key:string,stamp:number,interval:number):boolean{
    if(!Number.isFinite(stamp)||!Number.isFinite(interval)||interval<0)throw new Error('间隔时间无效');
    if(stamp<=0){this.anchors.delete(key);return true;}
    const mono=this.monotonic(),previous=this.anchors.get(key),anchor=previous?.stamp===stamp?previous:{stamp,mono,age:Math.max(0,this.wall()-stamp)};
    this.set(key,anchor);return anchor.age+Math.max(0,mono-anchor.mono)>=interval;
  }
  get size(){return this.anchors.size;}
}
