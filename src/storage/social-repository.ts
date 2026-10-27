import type {SocialData,StoredMessage,ScheduledTask} from '../qq/social-store.js';
import type {MessageEvent,Segment} from '../qq/onebot.js';

export type SocialField=Exclude<keyof SocialData,'messages'>;
export type MessageQuery={chat?:string;ids?:number[];limit?:number;offset?:number;query?:string;after?:number;ascending?:boolean;incomingOnly?:boolean;excludeUsers?:string[]};
export type MessageRef={chat:string;id:number};
type Awaitable<T>=T|Promise<T>;

/** 元数据视图有界缓存；归档查询允许异步实现，不要求将历史加载到业务进程。 */
export interface SocialRepository {
  readonly path:string;
  load():Promise<void>;
  view(...fields:SocialField[]):SocialData;
  context(chat:string):Awaitable<SocialData>;
  queryMessages(query:MessageQuery):Awaitable<{rows:StoredMessage[];total:number}>;
  lookupMessages(refs:MessageRef[]):Awaitable<StoredMessage[]>;
  latestIncoming(excludeUsers?:string[]):Awaitable<StoredMessage[]>;
  profile(chat:string):SocialData['profiles'][number]|undefined;
  memories(chat:string):SocialData['memories'];
  contacts():SocialData['contacts'];
  dueTasks(now:number):ScheduledTask[];
  messages(chat:string,limit?:number,offset?:number,query?:string):Awaitable<StoredMessage[]>;
  message(chat:string,id:number):Awaitable<StoredMessage>;
  update<T>(fn:(draft:SocialData)=>T):Promise<T>;
  updateWithMessages<T>(chat:string,ids:number[],fn:(draft:SocialData)=>T):Promise<T>;
  flush():Promise<unknown>;
  account(id:number):Promise<void>;
  record(event:MessageEvent,days:number,perChat:number):Promise<void>;
  add(entry:StoredMessage,days?:number,perChat?:number):Promise<void>;
  sent(chat:string,user:number,id:number,segments:Segment[],name:string):Promise<void>;
  beginAction(chat:string,tool:string):Promise<string>;
  endAction(id:string,state:'success'|'failed'|'unknown',summary:string):Promise<void>;
  addEvent(chat:string,type:string,data:Record<string,unknown>):Promise<string>;
  addTask(input:Omit<ScheduledTask,'id'|'state'|'error'|'retryAt'>):Promise<ScheduledTask>;
}
