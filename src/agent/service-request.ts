import {AsyncLocalStorage} from 'node:async_hooks';
import type {RequestScope} from './request-budget.js';
import type {ReportedUsage} from '../storage/database-types.js';
export type ServiceRequest={kind:'vision'|'transcription'|'speech'|'learning';model:string;bytes:number;signal:AbortSignal;chat?:string;maxOutputTokens?:number};
export type ServiceLimits={maxOutputTokens:number;maxResponseChars:number};
export type PreparedServiceRequest={run:<T>(operation:(limits:ServiceLimits,report:(usage:ReportedUsage)=>void)=>Promise<T>)=>Promise<T>;close:()=>Promise<void>};
export type PrepareServiceRequest=(request:ServiceRequest)=>Promise<PreparedServiceRequest>;
const scopes=new AsyncLocalStorage<RequestScope>();
export const withServiceRequestScope=<T>(scope:RequestScope,operation:()=>T):T=>scopes.run(scope,operation);
export const serviceRequestScope=():RequestScope|undefined=>scopes.getStore();
export function reportedServiceUsage(raw:any):ReportedUsage {
  const known=(...values:unknown[]):number|null=>{for(const value of values)if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1e9)return value;return null;};
  const result:ReportedUsage={inputTokens:known(raw?.inputTokens,raw?.input_tokens,raw?.prompt_tokens),outputTokens:known(raw?.outputTokens,raw?.output_tokens,raw?.completion_tokens)};
  if(raw?.cacheReadTokens!==undefined||raw?.cache_read_input_tokens!==undefined)result.cacheReadTokens=known(raw.cacheReadTokens,raw.cache_read_input_tokens);
  if(raw?.cacheWriteTokens!==undefined||raw?.cache_creation_input_tokens!==undefined)result.cacheWriteTokens=known(raw.cacheWriteTokens,raw.cache_creation_input_tokens);
  if(raw?.totalTokens!==undefined||raw?.total_tokens!==undefined)result.totalTokens=known(raw.totalTokens,raw.total_tokens);return result;
}
