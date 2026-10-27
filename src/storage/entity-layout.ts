import type {SocialData} from '../qq/social-store.js';
import type {EntityTable,EntityRow} from './database-types.js';
import type {SocialField} from './social-repository.js';

export const arrayLocations:Partial<Record<EntityTable,[SocialField,string?]>>={contacts:['contacts'],memories:['memories'],stickers:['stickers'],tasks:['tasks'],events:['events'],actions:['actions'],turns:['turns'],profiles:['profiles'],interests:['autonomous','interests'],thoughts:['autonomous','thoughts'],decisions:['autonomous','decisions'],autonomous_contacts:['autonomous','contacts'],sticker_uses:['autonomous','stickerUses'],posts:['autonomous','posts'],space_comments:['autonomous','spaceComments'],lexicon:['cognition','lexicon'],suppressed:['cognition','suppressed'],learning_jobs:['cognition','jobs']};
export function rawDataFromRows(rows:EntityRow[]):SocialData {
  const data:SocialData={version:2,account:0,messages:[],contacts:[],memories:[],stickers:[],tasks:[],events:[],actions:[],turns:[],profiles:[],autonomous:{interests:[],thoughts:[],decisions:[],contacts:[],stickerUses:[],posts:[],spaceComments:[],lastDecisionAt:0,lastCommentAttempt:0,commentCursor:0,lastScanAt:0,lastQzoneAttempt:0},cognition:{memories:{},lexicon:[],suppressed:[],scopes:{},jobs:[]}};
  for(const row of rows){
    const location=arrayLocations[row.table];if(location){const list=location[1]?(data[location[0]] as any)[location[1]]:data[location[0]];(list as unknown[]).push(row.value);}
    else if(row.table==='memory_meta')Object.defineProperty(data.cognition.memories,row.key,{value:row.value,enumerable:true,writable:true,configurable:true});
    else if(row.table==='learning_scopes')Object.defineProperty(data.cognition.scopes,row.key,{value:row.value,enumerable:true,writable:true,configurable:true});
    else if(row.table==='state'&&row.key==='account')data.account=row.value as number;
    else if(row.table==='state'&&row.key==='autonomous')Object.assign(data.autonomous,row.value);
  }
  return data;
}
