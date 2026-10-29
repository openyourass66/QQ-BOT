import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {OperationRecord} from '../storage/operation-types.js';

export type OperationScope={record:OperationRecord;owner:string;quotaSequence:number;stepSequence:number;signal:AbortSignal;authorize:()=>void};
const scopes=new AsyncLocalStorage<OperationScope>();
export const currentOperation=()=>scopes.getStore();
export const withOperation=<T>(scope:OperationScope,operation:()=>T):T=>scopes.run(scope,operation);
export const withoutOperation=<T>(operation:()=>T):T=>scopes.exit(operation);
export function canonicalOperation(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalOperation).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonicalOperation(item)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export const operationDigest=(value:unknown)=>createHash('sha256').update(canonicalOperation(value)).digest('hex');
