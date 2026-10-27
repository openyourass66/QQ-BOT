import {createHash} from 'node:crypto';
import {SocialDataSchema,type SocialData} from '../qq/social-store.js';
import {entityTables,type EntityTable,type EntityRow} from './database-types.js';
import type {SocialField} from './social-repository.js';
import {arrayLocations as arrays,rawDataFromRows} from './entity-layout.js';

export const emptySocialData=():SocialData=>SocialDataSchema.parse({version:2,messages:[],contacts:[],memories:[],stickers:[],tasks:[],events:[],actions:[],turns:[]});
const keyOf=(table:EntityTable,value:any):string=>{
  if(['contacts','profiles','autonomous_contacts'].includes(table))return value.chat;
  if(['posts','space_comments'].includes(table))return value.hash;
  if(table==='sticker_uses')return JSON.stringify([value.chat,value.stickerId,value.at]);
  if(table==='suppressed')return JSON.stringify([value.chat,value.hash,value.at]);
  return value.id;
};
export function entityRows(data:SocialData,fields:SocialField[]=Object.keys(data).filter(key=>key!=='messages') as SocialField[]):EntityRow[]{
  const rows:EntityRow[]=[];
  for(const table of entityTables){
    const location=arrays[table];
    if(location&&fields.includes(location[0])){
      const value=location[1]?(data[location[0]] as any)[location[1]]:data[location[0]],keys=new Map<string,number>();
      for(const [ordinal,item] of (value as unknown[]).entries()){
        let key=keyOf(table,item);if(typeof key!=='string')throw new Error('数据记录缺少有效编号，原数据保留。');const count=keys.get(key)??0;keys.set(key,count+1);
        if(count){if(!['sticker_uses','suppressed'].includes(table))throw new Error('数据记录编号重复，原数据保留，请先核对。');key=JSON.stringify([key,count]);}
        rows.push({table,key,ordinal,value:item});
      }
    }
  }
  if(fields.includes('cognition'))for(const [table,values] of [['memory_meta',data.cognition.memories],['learning_scopes',data.cognition.scopes]] as const)for(const [ordinal,[key,value]] of Object.entries(values).entries())rows.push({table,key,ordinal,value});
  if(fields.includes('account'))rows.push({table:'state',key:'account',ordinal:0,value:data.account});
  if(fields.includes('autonomous'))rows.push({table:'state',key:'autonomous',ordinal:0,value:Object.fromEntries(Object.entries(data.autonomous).filter(([,value])=>!Array.isArray(value)))});
  return rows;
}
export function dataFromRows(rows:EntityRow[]):SocialData {
  return SocialDataSchema.parse(rawDataFromRows(rows));
}
export function rowChanges(before:EntityRow[],after:EntityRow[]){
  const key=(row:EntityRow)=>`${row.table}/${row.key}`,previous=new Map(before.map(row=>[key(row),row])),next=new Set(after.map(key));
  return [...before.filter(row=>!next.has(key(row))).map(({table,key})=>({table,key})),...after.filter(row=>JSON.stringify(row)!==JSON.stringify(previous.get(key(row))))];
}
export const entityIdentity=(row:Pick<EntityRow,'table'|'key'>)=>`${row.table}/${row.key}`;
/** 保留未重排条目的位置；头部清理不会使剩余历史全部重写。 */
export function stableEntityOrder(before:EntityRow[],after:EntityRow[]):EntityRow[]{
  const previous=new Map(before.map(row=>[entityIdentity(row),row.ordinal]));
  for(const table of entityTables){
    const rows=after.filter(row=>row.table===table);let last=-Infinity,reordered=false;
    for(const row of rows){const ordinal=previous.get(entityIdentity(row));if(ordinal!==undefined){if(ordinal<=last){reordered=true;break;}last=ordinal;}}
    const assigned:number[]=[];last=-1024;
    if(!reordered)for(let index=0;index<rows.length;index++){
      const row=rows[index],existing=previous.get(entityIdentity(row));let ordinal=existing;
      if(ordinal===undefined){let nextIndex=index+1;while(nextIndex<rows.length&&!previous.has(entityIdentity(rows[nextIndex])))nextIndex++;const next=nextIndex<rows.length?previous.get(entityIdentity(rows[nextIndex]))!:undefined;
        if(next!==undefined&&next-last<=nextIndex-index){reordered=true;break;}ordinal=next===undefined?last+1024:last+1;
      }
      if(!Number.isSafeInteger(ordinal)){reordered=true;break;}assigned.push(ordinal);last=ordinal;
    }
    rows.forEach((row,index)=>{row.ordinal=reordered?index*1024:assigned[index];});
  }
  return after;
}
export function dataFingerprint(data:SocialData):string {
  const hash=createHash('sha256');for(const row of entityRows(data).sort((a,b)=>entityTables.indexOf(a.table)-entityTables.indexOf(b.table)||Buffer.compare(Buffer.from(a.key),Buffer.from(b.key))))hash.update(JSON.stringify(row)+'\n');
  for(const message of [...data.messages].sort((a,b)=>a.chat<b.chat?-1:a.chat>b.chat?1:a.id-b.id))hash.update(JSON.stringify(message)+'\n');return hash.digest('hex');
}
