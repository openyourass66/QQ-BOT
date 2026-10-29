import type {Thought} from '../agent/autonomous-state.js';

export function backgroundLane(thought:Thought):string{return `${thought.kind}:${thought.chat||thought.targetUser||'self'}`;}
const kinds=['chat','collect','qzone','qzone-comment'];
const compareLanes=(a:string,b:string)=>kinds.indexOf(a.split(':')[0])-kinds.indexOf(b.split(':')[0])||(a<b?-1:a>b?1:0);
/** Rotate eligible lanes; priority orders work within the selected lane. */
export function selectBackgroundThought(candidates:Thought[],cursor:string,now:number):Thought|undefined{
  if(!candidates.length)return undefined;
  const lanes=[...new Set(candidates.map(backgroundLane))].sort(compareLanes),lane=lanes.find(key=>compareLanes(key,cursor)>0)??lanes[0];
  const rank=(thought:Thought)=>thought.priority+Math.max(0,now-thought.at)/3600000*2;
  return candidates.filter(thought=>backgroundLane(thought)===lane).sort((a,b)=>rank(b)-rank(a)||a.at-b.at||a.id.localeCompare(b.id))[0];
}
