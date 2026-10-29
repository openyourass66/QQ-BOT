import {SessionStore,SessionStoreSchema} from '../core/store.js';
import {GroupContextStore,GroupContextSchema,GroupContextEntrySchema,type GroupContextEntry} from '../qq/group-context.js';
import {SqliteMapStore} from './sqlite-map-store.js';
import {z} from 'zod';

const groupRow=z.object({group:z.string().regex(/^\d+:\d+$/),position:z.number().int().nonnegative().safe(),entry:GroupContextEntrySchema}).strict();
const groupOrder=z.object({keys:z.array(z.string().regex(/^\d+:\d+$/)).max(100)}).strict();
type GroupRow=z.infer<typeof groupRow>;
function decodeGroups(value:unknown):Record<string,unknown>{
  const groups=GroupContextSchema.parse(value).groups,keys=Object.keys(groups);
  if(keys.length>100)throw Object.assign(new Error('群上下文超过支持容量，原文件保留。'),{code:'DATABASE_STATE_LIMIT'});const records:Record<string,unknown>={'$groups':groupOrder.parse({keys})};
  for(const [group,entries] of Object.entries(groups))for(const [position,entry] of entries.entries()){
    const key=group+'/'+entry.messageId;if(Object.hasOwn(records,key))throw new Error('群上下文消息编号重复');records[key]={group,position,entry};
  }return records;
}
function validateGroupRows(records:Record<string,unknown>):Record<string,unknown>{
  const order=groupOrder.parse(records.$groups),groups=new Map(order.keys.map(key=>[key,[] as GroupRow[]]));if(groups.size!==order.keys.length)throw new Error('群上下文顺序记录重复');
  const result:Record<string,unknown>={'$groups':order};for(const [key,value] of Object.entries(records))if(key!=='$groups'){
    const row=groupRow.parse(value),list=groups.get(row.group);if(key!==row.group+'/'+row.entry.messageId||!list||list.length>=80||list.some(item=>item.position===row.position))throw new Error('群上下文记录关联或容量无效');list.push(row);result[key]=row;
  }return result;
}

export class SqliteSessionStore extends SessionStore {
  private persistence:SqliteMapStore;
  onFailure?:(error:Error)=>void;
  constructor(path:string){super(path);this.persistence=new SqliteMapStore(this.path,{kind:'sessions',maxEntries:10000,decode:value=>SessionStoreSchema.parse(value).sessions,wrap:sessions=>({version:1,sessions})});this.persistence.onFailure=error=>this.onFailure?.(error);}
  override async load():Promise<void>{this.data=SessionStoreSchema.parse({version:1,sessions:await this.persistence.load()});}
  override set(key:string,sessionId:string,policy?:string,generation?:number):void{
    if(!Object.hasOwn(this.data.sessions,key)&&Object.keys(this.data.sessions).length>=10000)throw Object.assign(new Error('会话映射已达到一万条上限，请先整理旧会话。'),{code:'DATABASE_STATE_LIMIT'});
    super.set(key,sessionId,policy,generation);
  }
  protected override changed(key:string):void {this.persistence.put(key,this.data.sessions[key]);}
  override flush():Promise<void>{return this.persistence.flush();}
  close():Promise<void>{return this.persistence.close();}
}

export class SqliteGroupContextStore extends GroupContextStore {
  private persistence:SqliteMapStore;
  private prunedAt=-Infinity;
  private saved=new Map<string,Map<number,{position:number;signature:string}>>();
  private positions=new Map<string,number>();
  private order='';
  onFailure?:(error:Error)=>void;
  constructor(path:string,now:()=>number=Date.now){
    super(path,now);this.persistence=new SqliteMapStore(this.path,{kind:'group-context',maxEntries:8001,decode:decodeGroups,wrap:()=>({version:1,groups:{}}),validateEntries:validateGroupRows});this.persistence.onFailure=error=>this.onFailure?.(error);
  }
  override async load():Promise<void>{
    const records=await this.persistence.load(),keys=groupOrder.parse(records.$groups).keys,rows=Object.entries(records).filter(([key])=>key!=='$groups').map(([,value])=>value as GroupRow);
    for(const key of keys){const entries=rows.filter(row=>row.group===key).sort((a,b)=>a.position-b.position);this.groups.set(key,entries.map(row=>row.entry));const saved=new Map<number,{position:number;signature:string}>();
      for(const row of entries){this.seq=Math.max(this.seq,row.entry.seq);this.positions.set(key,Math.max(this.positions.get(key)??0,row.position+1));saved.set(row.entry.messageId,{position:row.position,signature:JSON.stringify(row.entry)});}this.saved.set(key,saved);
    }this.order=JSON.stringify(keys);
    this.prune();await this.flush();
  }
  protected override changed(keys:string[]):void {
    const updates:Array<{key:string;value:unknown}>=[];
    for(const key of new Set(keys)){
      const previous=this.saved.get(key)??new Map<number,{position:number;signature:string}>(),next=new Map<number,{position:number;signature:string}>();
      for(const entry of this.groups.get(key)??[]){const old=previous.get(entry.messageId),signature=JSON.stringify(entry);let position=old?.position;
        if(position===undefined){position=this.positions.get(key)??0;this.positions.set(key,position+1);}next.set(entry.messageId,{position,signature});
        if(old?.signature!==signature)updates.push({key:key+'/'+entry.messageId,value:{group:key,position,entry}});
      }
      for(const id of previous.keys())if(!next.has(id))updates.push({key:key+'/'+id,value:undefined});
      if(this.groups.has(key))this.saved.set(key,next);else{this.saved.delete(key);this.positions.delete(key);}
    }
    const order=JSON.stringify([...this.groups.keys()]);if(order!==this.order){updates.push({key:'$groups',value:{keys:[...this.groups.keys()]}});this.order=order;}this.persistence.putMany(updates);
  }
  private prune():void {
    const now=this.now();if(now>=this.prunedAt&&now-this.prunedAt<60000)return;this.prunedAt=now;
    for(const [key,entries] of this.groups){const active=entries.filter(entry=>now-entry.at<86400000);if(active.length!==entries.length){if(active.length)this.groups.set(key,active);else this.groups.delete(key);this.changed([key]);}}
  }
  override record(account:number,group:number,input:Omit<GroupContextEntry,'seq'|'at'>):GroupContextEntry {this.prune();return super.record(account,group,input);}
  override flush():Promise<void>{this.prune();return this.persistence.flush();}
  close():Promise<void>{return this.persistence.close();}
}
