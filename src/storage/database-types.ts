import type {StoredMessage} from '../qq/social-store.js';
import type {MessageQuery,MessageRef} from './social-repository.js';

export const entityTables=['contacts','memories','stickers','tasks','events','actions','turns','profiles','interests','thoughts','decisions','autonomous_contacts','sticker_uses','posts','space_comments','memory_meta','lexicon','suppressed','learning_scopes','learning_jobs','state'] as const;
export type EntityTable=typeof entityTables[number];
export type EntityRow={table:EntityTable;key:string;ordinal:number;value:unknown};
export type EntityChange={table:EntityTable;key:string;ordinal?:number;value?:unknown};
export type DatabaseRequest=
  |{action:'metadata'}
  |{action:'import';rows:Array<EntityRow|{table:'messages';key:string;ordinal:number;value:StoredMessage}>}
  |{action:'complete-import';source:Record<string,unknown>}
  |{action:'mutate';expectedRevision:number;changes:EntityChange[];messages?:StoredMessage[]}
  |{action:'add-message';expectedRevision:number;entry:StoredMessage;cutoff:number;perChat:number}
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
