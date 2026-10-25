import type { BotSettings } from '../core/settings.js';

/** Shared by all copies of a turn context so parallel tools cannot reset their counters. */
export type TurnBudget = {tools:number;searches:number;pages:number;urls:Set<string>};
export const turnBudget=():TurnBudget=>({tools:0,searches:0,pages:0,urls:new Set()});
export function clipBackground(text:string,max:number):string {
  if(text.length<=max)return text;
  const lines=text.split('\n'),result:string[]=[];let size=0;
  for(let i=lines.length-1;i>=0;i--){if(size+lines[i].length+1>max)continue;result.unshift(lines[i]);size+=lines[i].length+1;}
  return result.join('\n');
}
export function readContextUsage(update:unknown):{used:number;size:number}|undefined {
  if(!update||typeof update!=='object')return;
  const u=update as {sessionUpdate?:unknown;used?:unknown;size?:unknown};
  if(u.sessionUpdate==='usage_update'&&typeof u.used==='number'&&typeof u.size==='number'&&Number.isFinite(u.used)&&Number.isFinite(u.size)&&u.used>=0&&u.size>0)return {used:u.used,size:u.size};
}
export function toolAvailable(name:string,s:BotSettings,env:Record<string,string|undefined>=process.env):boolean {
  if(name.startsWith('qq_memory_')&&!s.social.memoryEnabled)return false;
  if(/sticker/.test(name)&&!s.social.stickersEnabled)return false;
  if(['qq_images','qq_send_image','qq_video','qq_speak','qq_transcribe'].includes(name)&&!s.social.mediaEnabled)return false;
  if(['qq_file','qq_event_file','qq_group_files','qq_group_file','qq_create_file','qq_send_file'].includes(name)&&!s.social.filesEnabled)return false;
  if(['qq_search','qq_web_read'].includes(name)&&!s.features.browsing.enabled)return false;
  if(name==='qq_search'){
    const ready=(provider:string)=>provider==='bing'||provider==='adapter'&&Boolean(env.BOT_SEARCH_URL)||provider==='tavily'&&Boolean(env.BOT_TAVILY_API_KEY);
    if(!ready(s.web.provider)&&!ready(s.web.fallback))return false;
  }
  if(['qq_set_reminder','qq_reminders','qq_cancel_reminder'].includes(name)&&!s.social.remindersEnabled)return false;
  if(name==='qq_handle_request'&&!s.social.requestsEnabled)return false;
  if(name==='qq_speak'&&(!s.social.speechModel||!env.BOT_MEDIA_BASE_URL))return false;
  if(name==='qq_transcribe'&&(!s.social.transcriptionModel||!env.BOT_MEDIA_BASE_URL))return false;
  if(name==='qq_video'&&!env.BOT_FFMPEG_BIN)return false;
  if(['qq_qzone_feed','qq_qzone_comment'].includes(name)&&!env.BOT_QZONE_ADAPTER_URL)return false;
  if(name==='qq_qzone_post'&&!s.features.qzone.enabled)return false;
  return true;
}
