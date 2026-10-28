import type {StoredMessage} from '../qq/social-store.js';
import type {MessageQuery,MessageRef} from './social-repository.js';
import type {Quota} from '../core/usage.js';
import type {OperationDatabaseRequest} from './operation-types.js';

export const entityTables=['contacts','memories','stickers','tasks','events','actions','turns','profiles','interests','thoughts','decisions','autonomous_contacts','sticker_uses','posts','space_comments','memory_meta','lexicon','suppressed','learning_scopes','learning_jobs','state'] as const;
export type EntityTable=typeof entityTables[number];
export type EntityRow={table:EntityTable;key:string;ordinal:number;value:unknown};
export type EntityChange={table:EntityTable;key:string;ordinal?:number;value?:unknown};
export type ModelRequestRecord={id:string;turn:string;kind:'conversation'|'compaction'|'vision'|'transcription'|'speech'|'learning'|'search'|'fetch';background:boolean;chat:string;user:string;provider:string;model:string;maxOutputTokens:number};
export type ReportedUsage={inputTokens:number|null;outputTokens:number|null;cacheReadTokens?:number|null;cacheWriteTokens?:number|null;totalTokens?:number|null};
export type UsageDatabaseRequest=OperationDatabaseRequest
  |{action:'usage-import';date:string;counters:Record<string,number>;final?:boolean}
  |{action:'usage-summary';date:string}
  |{action:'usage-consume';date:string;quotas:Quota[];reservationId:string;at:number;request?:ModelRequestRecord;operation?:{id:string;owner:string}}
  |{action:'usage-finish-model';id:string;outcome:'completed'|'failed'|'unknown';usage:ReportedUsage}
  |{action:'usage-recover-models'}
  |{action:'usage-request-stats';date:string};
export type DatabaseRequest=UsageDatabaseRequest
  |{action:'metadata'}
  |{action:'import';rows:Array<EntityRow|{table:'messages';key:string;ordinal:number;value:StoredMessage}>}
  |{action:'complete-import';source:Record<string,unknown>}
  |{action:'mutate';expectedRevision:number;changes:EntityChange[];messages?:StoredMessage[];guard?:{table:'thoughts';key:string;claimId:string}}
  |{action:'add-message';expectedRevision:number;entry:StoredMessage;cutoff:number;perChat:number;receiptAt?:number}
  |{action:'due-tasks';now:number;limit:number}
  |{action:'claim-task';expectedRevision:number;id:string;claimId:string;owner:string;now:number}
  |{action:'finish-task';expectedRevision:number;id:string;claimId:string;state:'pending'|'blocked'|'sent'|'failed'|'unknown';error:string;retryAt:number;due?:number}
  |{action:'due-thoughts';now:number;limit:number}
  |{action:'claim-thought';expectedRevision:number;id:string;claimId:string;owner:string;now:number}
  |{action:'query-messages';query:MessageQuery}
  |{action:'lookup-messages';refs:MessageRef[];evidenceOnly?:boolean}
  |{action:'latest-incoming';excludeUsers:string[]}
  |{action:'integrity'}
  |{action:'fingerprint'}
  |{action:'query-plan';chat:string}
  |{action:'backup';path:string}
  |{action:'export-social';path:string}
  |{action:'close'};
export const DATABASE_LIMITS={pending:64,pendingBytes:8*1024*1024,requestBytes:2*1024*1024,responseBytes:16*1024*1024,timeoutMs:30000};
