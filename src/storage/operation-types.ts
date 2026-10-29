export type OperationState='created'|'reserved'|'submitting'|'completed'|'failed'|'unknown';
export type OperationRecord={id:string;turn:string;account:number;chat:string;user:string;origin:'message'|'notice'|'background'|'owner'|'system';tool:string;payload:unknown;summary:string};
export type StoredOperation={record:OperationRecord;state:OperationState;at:number;date:string;result:unknown;error:string;owner:string};
export type OperationDatabaseRequest=
  |{action:'usage-op-begin';record:OperationRecord;owner:string;date:string;at:number;hash:string;semanticHash:string}
  |{action:'usage-op-submit';id:string;owner:string;sequence:number;name:string;payload:unknown;hash:string;at:number}
  |{action:'usage-op-step';id:string;owner:string;sequence:number;state:'completed'|'unknown';result?:unknown;error?:string}
  |{action:'usage-op-complete';id:string;owner:string;result:unknown}
  |{action:'usage-op-fail';id:string;owner:string;error:string}
  |{action:'usage-op-read';id:string}
  |{action:'usage-op-list';account:number;chat?:string;limit:number;offset:number}
  |{action:'usage-op-recover'};
