import { z } from 'zod';
import { SocialStore } from './social-store.js';
import { MediaService } from '../services/media.js';
import { socialTools } from './social-tools.js';
import { legacyTools } from './legacy-tools.js';
import { getSettings, getSettingsPath, saveSettings } from '../core/settings.js';
import type { DailyUsageStore } from '../core/usage.js';
import { stickerSearchText } from './sticker-review.js';
import { reviseMemory, forgetMemory, memoryMeta, fingerprint } from '../agent/cognition.js';
import { learningModel } from '../agent/learning-model.js';
import { toolAvailable } from '../agent/context-policy.js';

const requestSchema = z.object({
  op: z.enum(['list', 'edit_memory', 'delete', 'block', 'allow', 'refresh_contacts', 'reset_session', 'profile', 'collect_sticker','edit_interest','defer_thought','lock_memory','restore_memory','edit_lexicon','activate_lexicon','disable_lexicon','restore_lexicon','review_memory']),
  section: z.enum(['contacts','messages','memories','stickers','tasks','events','actions','turns','capabilities','thoughts','interests','decisions','lexicon','learning']).default('contacts'),
  chat: z.string().max(64).default(''), query: z.string().max(256).default(''), id: z.string().max(128).default(''),
  text: z.string().max(10000).default(''), expectedText: z.string().max(2000).optional(), blocked: z.boolean().default(true),
  responseMode: z.enum(['inherit','mention','keywords','probability','all']).default('inherit'),
  probability: z.number().int().min(0).max(100).default(10), keywords: z.string().max(1000).default(''), proactive: z.boolean().default(true),
}).strict().refine(value => value.op === 'profile' || value.text.length <= 2000, { message: '记忆内容最多 2000 字', path: ['text'] });

export async function socialAdmin(input: unknown, store: SocialStore, media: MediaService,
  live?: { refresh(): Promise<void>; reset(chat: string): Promise<void>; review?(chat:string):Promise<void>; usage?: DailyUsageStore; stickers?: { sync(): Promise<unknown>;collect(id:string):Promise<void>;remove(id:string):Promise<void> } }, offlineUsage?: DailyUsageStore): Promise<unknown> {
  const a = requestSchema.parse(input);
  if(a.op==='review_memory'){if(!live?.review)throw new Error('请启动机器人后整理当前会话');await live.review(a.chat);}
  if(['lock_memory','restore_memory'].includes(a.op))await store.update(d=>{
    if(a.section!=='memories')throw new Error('请选择群友记忆');
    const m=d.memories.find(m=>m.id===a.id);if(!m)throw new Error('记忆不存在');
    if(a.expectedText!==undefined&&m.text!==a.expectedText)throw new Error('记忆已修改，请刷新后核对');
    const meta=memoryMeta(d,m.id);
    if(a.op==='lock_memory'){meta.locked=!meta.locked;meta.revision++;d.cognition.memories[m.id]=meta;}
    else {const old=meta.history.at(-1);if(!old)throw new Error('没有可恢复的版本');reviseMemory(d,m.id,old.text,'恢复上一版本');}
  });
  if(['edit_lexicon','activate_lexicon','disable_lexicon','restore_lexicon'].includes(a.op))await store.update(d=>{
    if(a.section!=='lexicon')throw new Error('请选择群内用语');
    const item=d.cognition.lexicon.find(l=>l.id===a.id);if(!item)throw new Error('词条不存在');
    if(a.expectedText!==undefined&&item.meaning!==a.expectedText)throw new Error('词条已修改，当前编辑已保留，请刷新后核对');
    if(a.op==='edit_lexicon'){if(!a.text.trim()||a.text.length>300)throw new Error('词条含义需要 1–300 字');item.history.push({text:item.meaning,at:Date.now(),reason:'管理员编辑'});item.meaning=a.text.trim();item.locked=true;}
    else if(a.op==='restore_lexicon'){const old=item.history.at(-1);if(!old)throw new Error('没有可恢复的版本');const current=item.meaning;item.meaning=old.text;item.history.push({text:current,at:Date.now(),reason:'恢复上一版本'});item.locked=true;}
    else if(a.op==='activate_lexicon'){item.status='active';item.locked=true;}
    else item.status='disabled';
    item.revision++;item.history=item.history.slice(-10);
  });
  if(a.op==='edit_interest') {
    if(a.section!=='interests'||!a.text.trim()||a.text.trim().length>80)throw new Error('兴趣主题需要 1–80 字');
    await store.update(d=>{const i=d.autonomous.interests.find(i=>i.id===a.id);if(!i)throw new Error('兴趣不存在');if(a.expectedText!==undefined&&i.topic!==a.expectedText)throw new Error('兴趣已被其他操作修改，请刷新后核对');i.topic=a.text.trim();i.updatedAt=Date.now();});
  }
  if(a.op==='defer_thought') {
    if(a.section!=='thoughts')throw new Error('请选择自主想法');
    await store.update(d=>{const t=d.autonomous.thoughts.find(t=>t.id===a.id);if(!t||t.state!=='pending')throw new Error('只能推迟尚未执行的想法');const due=Date.now()+3600000;if(due>=t.expires)throw new Error('想法即将过期，无法再推迟一小时');t.due=due;t.result='管理员推迟一小时';});
  }
  if(a.section==='stickers'&&live?.stickers&&['list','refresh_contacts'].includes(a.op))await live.stickers.sync();
  if(a.op==='collect_sticker') { if(a.section!=='stickers'||!live?.stickers)throw new Error('请启动机器人后将所选表情存入 QQ 收藏');await live.stickers.collect(a.id); }
  if (a.op === 'profile') {
    if (!/^(group|private):\d+$/.test(a.chat)) throw new Error('请选择一个有效会话');
    await store.update(d => {
      const profile = { chat: a.chat, persona: a.text, responseMode: a.responseMode, probability: a.probability, keywords: a.keywords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean), proactive: a.proactive };
      const index = d.profiles.findIndex(p => p.chat === a.chat); if (index < 0) d.profiles.push(profile); else d.profiles[index] = profile;
    });
  }
  if (a.op === 'refresh_contacts'&&a.section!=='stickers') { if (!live) throw new Error('请启动机器人后刷新 QQ 联系人'); await live.refresh(); }
  if(a.op==='refresh_contacts'&&a.section==='stickers'&&!live?.stickers)throw new Error('请启动机器人后刷新 QQ 收藏');
  if (a.op === 'reset_session') { if (!live) throw new Error('请启动机器人后重置会话'); await live.reset(a.chat); }
  if (a.op === 'block' || a.op === 'allow') {
    if (!/^(group|private):\d+$/.test(a.chat)) throw new Error('请选择一个有效会话');
    const s = getSettings(), [kind, id] = a.chat.split(':');
    const key = a.op === 'block' ? (kind === 'group' ? 'blockedGroups' : 'blockedUsers') : (kind === 'group' ? 'allowedGroups' : 'allowedUsers');
    s.social[key] = a.blocked ? [...new Set([...s.social[key], id])] : s.social[key].filter(value => value !== id);
    await saveSettings(s);
  }
  if (a.op === 'edit_memory') {
    if (!a.text.trim()) throw new Error('记忆内容不能为空');
    await store.update(d => { const m = d.memories.find(m => m.id === a.id); if (!m) throw new Error('记忆不存在'); if (a.expectedText !== undefined && m.text !== a.expectedText) throw new Error('记忆已被其他操作修改，请刷新后核对；当前编辑仍保留'); reviseMemory(d,m.id,a.text); });
  }
  if(a.op==='delete'&&a.section==='stickers') {
    const item=store.snapshot().stickers.find(s=>s.id===a.id);if(!item)throw new Error('表情不存在');
    if(item.qq) {if(!live?.stickers)throw new Error('请启动机器人后从 QQ 收藏中移除表情');await live.stickers.remove(a.id);}
    else await store.update(d=>{d.stickers=d.stickers.filter(s=>s.id!==a.id);});
  }
  if (a.op === 'delete'&&a.section!=='stickers') await store.update(d => {
    if (a.section === 'memories') { const m = d.memories.find(m => m.id === a.id); if (!m) throw new Error('记忆不存在'); if (a.expectedText !== undefined && m.text !== a.expectedText) throw new Error('记忆已被其他操作修改，请刷新后核对；当前编辑仍保留'); forgetMemory(d,m.id); }
    else if(a.section==='lexicon'){const item=d.cognition.lexicon.find(l=>l.id===a.id);if(!item)throw new Error('词条不存在');if(a.expectedText!==undefined&&item.meaning!==a.expectedText)throw new Error('词条已修改，当前编辑已保留');d.cognition.suppressed.push({chat:item.chat,hash:fingerprint(item.term),at:Date.now()});d.cognition.suppressed=d.cognition.suppressed.slice(-10000);d.cognition.lexicon=d.cognition.lexicon.filter(l=>l.id!==a.id);}
    else if (a.section === 'tasks') { const t = d.tasks.find(t => t.id === a.id); if (!t || !['pending','blocked'].includes(t.state)) throw new Error('只能取消尚未执行的提醒'); t.state = 'cancelled'; }
    else if(a.section==='thoughts'){const t=d.autonomous.thoughts.find(t=>t.id===a.id);if(!t||!['pending','running'].includes(t.state))throw new Error('这条想法已经结束');t.state='dismissed';t.result='管理员取消，不再执行';}
    else if(a.section==='interests'){if(!d.autonomous.interests.some(i=>i.id===a.id))throw new Error('兴趣不存在');d.autonomous.interests=d.autonomous.interests.filter(i=>i.id!==a.id);}
    else throw new Error('该列表不支持删除');
  });
  const data = store.snapshot(), s = getSettings();
  type Row = { id: string; chat: string; name: string; summary: string; status: string; time: string; detail: string; text: string };
  const date = (at: number) => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
  const rows: Row[] = [];
  const add = (id: string, chat: string, name: string, summary: string, status: string, at: number, detail = summary, text = '') => {
    if (a.op === 'list' && a.chat && chat !== a.chat) return;
    if (a.query && !`${name} ${summary} ${chat} ${['memories','stickers'].includes(a.section) ? detail : ''}`.toLowerCase().includes(a.query.toLowerCase())) return;
    rows.push({ id, chat, name, summary: summary.slice(0,160), status, time: date(at), detail, text });
  };
  switch (a.section) {
    case 'thoughts':for(const t of [...data.autonomous.thoughts].sort((x,y)=>Number(['pending','running'].includes(y.state))-Number(['pending','running'].includes(x.state))||y.at-x.at)) {
      const status={pending:'等待判断',running:'执行中',done:'完成',dismissed:'已放弃',expired:'已过期',unknown:'结果待核对'}[t.state];
      add(t.id,t.chat,t.summary,t.reason,status,t.at,`行动：${{chat:'主动聊天',collect:'看图判断收藏',qzone:'独立空间创作'}[t.kind]}\n来源：${t.chat||'公开创作兴趣'}${t.messageId!==undefined?' · 消息 #'+t.messageId:''}\n\n理由：${t.reason}\n适合时间：${date(t.due)}\n有效期至：${date(t.expires)}\n\n结果：${t.result||'尚未判断'}`);
    }break;
    case 'interests':for(const i of [...data.autonomous.interests].sort((x,y)=>y.updatedAt-x.updatedAt))add(i.id,i.chat,i.topic,i.reason,`兴趣程度 ${i.strength}/5`,i.updatedAt,`来源：${i.chat||'公开兴趣'}\n兴趣程度：${i.strength}/5\n\n依据：${i.reason}`,i.topic);break;
    case 'decisions':for(const d of [...data.autonomous.decisions].reverse())add(d.id,d.chat,{chat:'主动聊天判断',collect:'收藏判断',qzone:'空间创作判断'}[d.kind],d.reason,{done:'完成',dismissed:'保持安静',pending:'已推迟',unknown:'结果待核对',expired:'已过期'}[d.outcome]??d.outcome,d.at,`${d.reason}\n关联想法：${d.thoughtId}`);break;
    case 'contacts': for (const c of data.contacts) {
      const [kind,id] = c.chat.split(':');
      const blocked = (kind === 'group' ? s.social.blockedGroups : s.social.blockedUsers).includes(id);
      const profile = data.profiles.find(p=>p.chat===c.chat), override = profile && profile.responseMode!=='inherit';
      const mode = override ? profile.responseMode : s.social.responseMode;
      const modes:Record<string,string>={legacy:s.chat.group.requireMention?'仅被叫到时回应':'普通消息也可参与',mention:'仅直接对话',keywords:'直接对话和关键词',probability:'关键词和概率参与',all:'参与全部消息'};
      const allowed=s.social.allowAll||(kind==='group'?s.social.allowedGroups:s.social.allowedUsers).includes(id);
      const participation = kind==='group' ? `${override?'会话专属':'沿用全局'} · ${modes[mode]}` : `全局私聊自动回复${s.chat.privateAutoReply?'已开启':'已关闭'}`;
      add(c.chat, c.chat, c.name, participation, blocked ? '已屏蔽' : allowed?'可联系':'未在允许名单', c.at,
        `当前状态：${blocked?'已屏蔽':allowed?'可联系':'未在允许名单'}\n参与配置：${participation}${kind==='group'&&mode==='probability'?'\n参与概率：'+(override?profile.probability:s.social.responseProbability)+'%':''}\n会话人设：${profile?.persona?'使用会话独立副本':'沿用工作区人设'}\n会话后台活动：${profile?.proactive===false?'聊天与收藏已关闭':'沿用全局开关、安静时段与额度'}\n\n可在会话设置调整独立参与方式与人设。`);
    } break;
    case 'messages': for (const m of [...data.messages].reverse()) add(String(m.id), m.chat, m.name, m.text, m.recalled ? '已撤回' : m.self ? '自己发送' : '收到', m.at, `${m.name}（${m.user}）\n消息 #${m.id}\n${m.text}\n\n媒体：${m.segments.filter(s => s.type !== 'text').map(s => s.type).join('、')}`); break;
    case 'memories': for (const m of [...data.memories].reverse()) if(a.op!=='list'||!a.id||m.id===a.id) {
      const meta=memoryMeta(data,m.id);add(m.id,m.chat,m.name,m.text,`${meta.locked?'已锁定':'可整理'} · ${{active:'有效',conflict:'存在冲突',expired:'已过期',revoked:'已撤销'}[meta.status]}`,m.at,
        `QQ ${m.user}\n${m.text}\n\n来源：${{legacy:'历史记忆（无原消息依据）',admin:'管理员确认',tool:'对话工具记录',learned:'后台学习'}[meta.source]}\n依据消息：${meta.sources.join('、')||'无'}\n依据摘录：${meta.evidence.map(e=>`#${e.id} QQ ${e.user}：${e.quote}`).join('\n')||'无'}\n修订：${meta.revision} · ${meta.locked?'已锁定':'可整理'}\n\n历史版本：\n${meta.history.map(h=>`${date(h.at)} ${h.reason}\n${h.text}`).join('\n')||'无'}`,m.text);
    } break;
    case 'lexicon':for(const l of [...data.cognition.lexicon].reverse())add(l.id,l.chat,l.term,l.meaning,{candidate:'待确认',active:'有效',disabled:'已停用'}[l.status],l.at,
      `类型：${l.kind==='term'?'群内用语':'表达参考'}\n${l.meaning}\n\n依据消息：${l.sources.join('、')}\n修订：${l.revision} · ${l.locked?'管理员锁定':'自动候选'}\n历史版本：\n${l.history.map(h=>`${date(h.at)} ${h.reason}\n${h.text}`).join('\n')||'无'}`,l.meaning);break;
    case 'learning':for(const j of [...data.cognition.jobs].reverse())add(j.id,j.chat,'聊天资料整理',j.summary,{running:'分析中',completed:'完成',failed:'失败',unknown:'结果待核对',discarded:'未应用'}[j.state],j.at,`${j.summary}\n依据消息：${j.sources.join('、')}\n服务返回用量：${j.inputTokens===undefined?'未知':`${j.inputTokens} 输入 / ${j.outputTokens} 输出`}\n此记录统计一次无工具分析，不推算费用。`);break;
    case 'stickers': for (const t of data.stickers) {
      if(t.qq&&!t.qqPresent)continue;
      if (a.query && !(stickerSearchText(t) + ' ' + (t.analysis?.avoid.join(' ') ?? '').toLocaleLowerCase()).includes(a.query.toLocaleLowerCase())) continue;
      const understanding = t.analysis, confidence = understanding?.confidence === 'high' ? '高' : understanding?.confidence === 'medium' ? '中' : '低';
      const detail = `${t.qqPresent?'已在 QQ 账号收藏中':'仅保存在本地，尚未写入 QQ 收藏'}\n${t.qq?.description?'QQ 备注：'+t.qq.description+'\n':''}${t.note}\n标签：${t.tags.join('、')}\n` + (understanding ? `\n画面：${understanding.description}\n图片文字：${understanding.image_text || '无或看不清'}\n含义：${understanding.meaning}\n情绪：${understanding.emotions.join('、')}\n适用：${understanding.usage.join('；')}\n不适用：${understanding.avoid.join('；') || '未列出'}\n理解置信度：${confidence}\n` : '\n尚未完成看图理解，使用前需要补充分析。\n') + (t.file?'本地缓存：'+t.file:'图片尚未缓存到本机');
      add(t.id,'',t.note,[t.tags.join('、'),understanding?.meaning,...(understanding?.emotions ?? []),...(understanding?.usage ?? [])].filter(Boolean).join(' · '),`${t.qqPresent?'QQ收藏':'仅本地·待同步QQ'} · ${!understanding ? '待理解' : understanding.confidence === 'low' ? '含义待确认' : '已理解'} · 已用 ${t.uses} 次`,t.at,detail);
    } break;
    case 'tasks': for (const t of [...data.tasks].reverse()) add(t.id,t.chat,t.text,t.error || t.text,{ pending:'等待执行',blocked:'等待条件恢复',running:'执行中',sent:'已发送',failed:'失败',unknown:'结果待核对',cancelled:'已取消' }[t.state],t.due,`${t.text}\n${t.error || ''}\n${t.interval ? `每 ${t.interval/60000} 分钟` : '一次性'}`); break;
    case 'events': for (const e of [...data.events].reverse()) add(e.id,e.chat,e.type,String(e.data.comment ?? e.data.sub_type ?? ''),e.handled ? '已处理' : '已记录',e.at,JSON.stringify(e.data,null,2)); break;
    case 'actions': for (const t of [...data.actions].reverse()) {
      const alias: Record<string,string> = { send_message:'qq_send_message', like:'qq_like', qzone_post:'qq_qzone_post' };
      const title = [...socialTools,...legacyTools].find(tool => tool.name === (alias[t.tool] ?? t.tool))?.title ?? t.tool;
      add(t.id,t.chat,title,t.summary,{ running:'执行中',success:'成功',failed:'失败',unknown:'结果待核对' }[t.state],t.at);
    } break;
    case 'turns': for (const t of [...data.turns].reverse()) add(t.id,t.chat,`${Math.round(t.duration/1000)} 秒`,t.output || t.error,t.error ? '失败' : '完成',t.at,`输入：\n${t.input}\n\n输出：\n${t.output}\n\n工具：${t.tools.join('、')}\n${t.error}\n\n用量：${t.inputTokens === null ? 'DSH 未提供计费用量' : t.inputTokens + ' 输入 / ' + t.outputTokens + ' 输出'}\n上下文：${t.contextSize?`${t.contextUsed}/${t.contextSize}（DSH 上报占用，非计费累计）`:'DSH 未上报'}\n会话代数：${t.generation??1}`); break;
    case 'capabilities': {
      const names: Record<string,string> = { images:'图片理解',transcription:'语音识别',speech:'语音合成',video:'视频理解',search:'联网搜索',qzone:'空间动态' };
      for (const [name,value] of Object.entries(media.capabilities())) add(name,'',names[name] ?? name,value,value.includes('未配置') ? '未配置' : '可检查',0);
      const analysis=learningModel().available();add('learning-model','','后台分析模型',analysis||'可使用无工具分析通道',analysis?'未配置':'可检查',0);
      add('managed-web','','本项目联网',s.features.browsing.enabled?`${s.web.provider}；DSH 外部工具独立管理`:'本项目联网已关闭',s.features.browsing.enabled?'可检查':'已关闭',0);
      for (const tool of [...socialTools,...legacyTools]) add(tool.name,'',tool.title,tool.description,toolAvailable(tool.name,s)?'已注册':'已关闭或缺少依赖',0);
      break;
    }
  }
  const note=a.section==='stickers'?`${live?.stickers?'已读取 QQ 收藏':'离线缓存，启动机器人后可刷新 QQ 收藏'} · QQ 收藏 ${data.stickers.filter(t=>t.qqPresent).length} 张；本地待同步 ${data.stickers.filter(t=>!t.qq).length} 张。` : rows.length?`显示前 ${Math.min(200,rows.length)} 条；时间为上海时间。`:'暂无记录。启动机器人后接收消息，或刷新联系人。';
  if(a.section==='memories'&&a.op==='edit_memory') {const selected=rows.findIndex(row=>row.id===a.id);if(selected>0)rows.unshift(rows.splice(selected,1)[0]);}
  const usage = live?.usage ?? offlineUsage;
  const quotas = usage?.summary([
    {key:'social-actions',label:'QQ 动作',limit:s.social.actionsPerDay},
    {key:'proactive',label:'主动消息',limit:s.budgets.proactiveMessagesPerDay},
    {key:'reminders',label:'定时提醒',limit:s.budgets.remindersPerDay},
    {key:'likes',label:'名片点赞',limit:s.budgets.likesPerDay},
    {key:'qzone',label:'空间发布',limit:s.features.qzone.dailyLimit},
    {key:'autonomous-decisions',label:'后台判断',limit:s.social.autonomousDecisionsPerDay},
    {key:'learning',label:'后台学习',limit:s.learning.dailyCalls},
    ...data.contacts.filter(c=>c.chat.startsWith('group:')).map(c=>({key:c.chat,label:c.name+' 主动消息与提醒',limit:s.chat.group.proactive.perGroupPerDay})),
  ]);
  return { op: a.op, section: a.section, rows: rows.slice(0,200), total: rows.length, profiles: data.profiles, socialSettings: s.social, settingsPath:getSettingsPath(), quotas:quotas?{...quotas,live:!!live}:null, note, usage: { turns: data.turns.length, tokensKnown: data.turns.filter(t => t.inputTokens !== null).length } };
}
