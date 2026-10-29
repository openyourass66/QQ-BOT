import {DatabaseSync} from 'node:sqlite';
import {SessionStoreSchema} from '../../dist/core/store.js';

export function readSessionMappings(path){
  const database=new DatabaseSync(path+'.sqlite',{readOnly:true});
  try{return SessionStoreSchema.parse({version:1,sessions:Object.fromEntries(database.prepare('SELECT key,payload FROM entity_state').all().map(row=>[row.key,JSON.parse(row.payload)]))});}
  finally{database.close();}
}
