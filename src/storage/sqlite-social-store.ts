import {SocialStore,SocialDataSchema,recoverInterrupted,type SocialData,type StoredMessage} from '../qq/social-store.js';
import {DatabaseClient} from './database-client.js';
import {dataFromRows,entityRows,rowChanges,stableEntityOrder,entityIdentity} from './social-entities.js';
import {ensureSocialDatabase,verifyMigrationSource,type MigrationProgress} from './social-migration.js';
import type {EntityRow} from './database-types.js';
import type {SocialField,MessageQuery,MessageRef} from './social-repository.js';

/** 仅缓存有界业务状态；消息历史留在 Worker，事务只提交有变化的条目。 */
export class SqliteSocialStore extends SocialStore {
  private database?:DatabaseClient;
  private revision=0;
  private positions=new Map<string,number>();
  private loaded=false;
  private queued=0;
  private closed=false;
  private closeTask?:Promise<void>;
  onFailure?:(error:Error)=>void;
  onMeasurement?:(action:string,elapsedMs:number)=>void;
  constructor(path:string,private options:{onMigrationProgress?:(progress:MigrationProgress)=>void|Promise<void>}={}){super(path);}
  override async load():Promise<void>{
    if(this.loaded)throw new Error('仓储已经打开，不能重复加载。');if(this.closed)throw new Error('仓储已经关闭。');
    const path=await ensureSocialDatabase(this.path,this.options.onMigrationProgress),client=new DatabaseClient(path);this.database=client;
    client.onFailure=error=>this.onFailure?.(error);client.onMeasurement=(action,elapsed)=>this.onMeasurement?.(action,elapsed);
    try{
      const metadata=await client.call<{revision:number;initialized:boolean;source:Record<string,unknown>;rows:EntityRow[]}>({action:'metadata'});
      if(!metadata.initialized)throw Object.assign(new Error('数据库迁移尚未完成，原文件保留。'),{code:'DATABASE_NOT_INITIALIZED'});
      await verifyMigrationSource(this.path,metadata.source);this.data=dataFromRows(metadata.rows);this.positions=new Map(metadata.rows.map(row=>[entityIdentity(row),row.ordinal]));this.revision=metadata.revision;this.loaded=true;
      await this.update(d=>recoverInterrupted(d));
    }catch(error){this.loaded=false;await client.close();throw error;}
  }
  override snapshot():SocialData {throw new Error('数据库不支持整库快照，请使用按业务字段或分页查询。');}
  private serial<T>(run:()=>Promise<T>):Promise<T>{
    if(!this.loaded||this.closed)return Promise.reject(new Error('仓储未打开或已经关闭。'));
    if(this.queued>=64)return Promise.reject(Object.assign(new Error('数据写入正在处理，请稍后重试。'),{code:'DATABASE_QUEUE_FULL'}));
    this.queued++;const next=this.chain.then(run);this.chain=next.catch(()=>{});return next.finally(()=>{this.queued--;});
  }
  override update<T>(fn:(draft:SocialData)=>T):Promise<T>{return this.serial(()=>this.mutate(fn));}
  override updateWithMessages<T>(chat:string,ids:number[],fn:(draft:SocialData)=>T):Promise<T>{
    return this.serial(async()=>this.mutate(fn,await this.database!.call<StoredMessage[]>({action:'lookup-messages',refs:ids.map(id=>({chat,id}))})));
  }
  private async mutate<T>(fn:(draft:SocialData)=>T,messages?:StoredMessage[]):Promise<T>{
    const copies=new Map<keyof SocialData,unknown>(),originalMessages=messages?structuredClone(messages):undefined;
    const draft=new Proxy(this.data,{
      get:(target,key)=>{
        if(typeof key!=='string'||!Object.hasOwn(SocialDataSchema.shape,key))return Reflect.get(target,key);
        const field=key as keyof SocialData;
        if(field==='messages'){if(!messages)throw new Error('消息事务必须显式指定来源编号。');return messages;}
        if(!copies.has(field))copies.set(field,structuredClone(target[field]));return copies.get(field);
      },
      set:(_target,key,value)=>{if(typeof key!=='string'||!Object.hasOwn(SocialDataSchema.shape,key)||key==='messages')throw new Error('无效的事务字段。');copies.set(key as keyof SocialData,value);return true;},
      deleteProperty:()=>{throw new Error('事务不能删除业务字段。');},
    });
    const result=structuredClone(fn(draft)),next={...this.data};
    for(const [key,value] of copies)Object.assign(next,{[key]:SocialDataSchema.shape[key].parse(value)});
    const fields=[...copies.keys()].filter(field=>field!=='messages') as SocialField[];
    const before=entityRows(this.data,fields).map(row=>({...row,ordinal:this.positions.get(entityIdentity(row))??row.ordinal}));
    const after=stableEntityOrder(before,entityRows(next,fields)),changes=rowChanges(before,after);
    let changedMessages:StoredMessage[]=[];
    if(messages){
      const parsed=SocialDataSchema.shape.messages.parse(messages),before=new Map(originalMessages!.map(m=>[`${m.chat}/${m.id}`,JSON.stringify(m)]));
      if(parsed.length!==before.size||parsed.some(m=>!before.has(`${m.chat}/${m.id}`)))throw new Error('来源消息事务不能新增、移除或更换消息编号。');
      changedMessages=parsed.filter(m=>JSON.stringify(m)!==before.get(`${m.chat}/${m.id}`));
    }
    if(changes.length||changedMessages.length){const saved=await this.database!.call<{revision:number}>({action:'mutate',expectedRevision:this.revision,changes,messages:changedMessages});this.revision=saved.revision;this.data=next;for(const row of changes){const key=entityIdentity(row);if('ordinal' in row&&typeof row.ordinal==='number')this.positions.set(key,row.ordinal);else this.positions.delete(key);}}
    return result;
  }
  override async add(entry:StoredMessage,days=30,perChat=2000):Promise<void>{
    const parsed=SocialDataSchema.shape.messages.element.parse(entry);
    if(!Number.isFinite(days)||days<=0||!Number.isSafeInteger(perChat)||perChat<1)throw new Error('消息保留参数无效。');
    await this.serial(async()=>{
      const saved=await this.database!.call<{revision:number;contacts:EntityRow[];removedContacts:string[]}>({action:'add-message',expectedRevision:this.revision,entry:parsed,cutoff:Date.now()-days*86400000,perChat});
      this.revision=saved.revision;
      for(const row of saved.contacts){this.positions.set(entityIdentity(row),row.ordinal);const item=row.value as SocialData['contacts'][number],index=this.data.contacts.findIndex(c=>c.chat===item.chat);if(index<0)this.data.contacts.push(item);else this.data.contacts[index]=item;}
      if(saved.removedContacts.length){this.data.contacts=this.data.contacts.filter(c=>!saved.removedContacts.includes(c.chat));for(const key of saved.removedContacts)this.positions.delete(entityIdentity({table:'contacts',key}));}
    });
  }
  override async queryMessages(query:MessageQuery):Promise<{rows:StoredMessage[];total:number}>{this.assertReadable();return this.database!.call({action:'query-messages',query});}
  override async lookupMessages(refs:MessageRef[]):Promise<StoredMessage[]>{this.assertReadable();return this.database!.call({action:'lookup-messages',refs});}
  override async latestIncoming(excludeUsers:string[]=[]):Promise<StoredMessage[]>{this.assertReadable();return this.database!.call({action:'latest-incoming',excludeUsers});}
  override async messages(chat:string,limit=30,offset=0,query=''):Promise<StoredMessage[]>{return (await this.queryMessages({chat,limit,offset,query})).rows.reverse();}
  override async message(chat:string,id:number):Promise<StoredMessage>{const rows=await this.lookupMessages([{chat,id}]);if(!rows.length)throw new Error('当前会话找不到该消息，请先查询近期消息，使用返回的真实消息编号');return rows[0];}
  override async context(chat:string):Promise<SocialData>{
    const data=this.view('memories','cognition');data.memories=data.memories.filter(m=>m.chat===chat);data.cognition.memories=Object.fromEntries(data.memories.filter(m=>data.cognition.memories[m.id]).map(m=>[m.id,data.cognition.memories[m.id]]));
    data.cognition.lexicon=data.cognition.lexicon.filter(l=>l.chat===chat);data.cognition.suppressed=data.cognition.suppressed.filter(s=>s.chat===chat);data.cognition.jobs=data.cognition.jobs.filter(j=>j.chat===chat);data.cognition.scopes=Object.fromEntries(Object.entries(data.cognition.scopes).filter(([key])=>key===chat));
    data.messages=(await this.queryMessages({chat,limit:80})).rows.reverse();const present=new Set(data.messages.map(m=>m.id));
    const sourceIds=[...new Set([...Object.values(data.cognition.memories).flatMap(meta=>meta.sources),...data.cognition.lexicon.flatMap(item=>item.sources)])].filter(id=>!present.has(id));
    for(let index=0;index<sourceIds.length;index+=512)data.messages.push(...await this.database!.call<StoredMessage[]>({action:'lookup-messages',refs:sourceIds.slice(index,index+512).map(id=>({chat,id})),evidenceOnly:true}));
    return data;
  }
  private assertReadable(){if(!this.loaded||this.closed)throw new Error('仓储未打开或已经关闭。');}
  close():Promise<void>{return this.closeTask??=(async()=>{this.closed=true;await this.chain;await this.database?.close();})();}
}
