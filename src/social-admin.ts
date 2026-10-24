import { z } from 'zod';
import { SocialStore } from './social-store.js';
import { MediaService } from './media.js';
import { socialTools } from './social-tools.js';
import { legacyTools } from './legacy-tools.js';
import { getSettings, saveSettings } from './settings.js';

const requestSchema = z.object({
  op: z.enum(['list', 'edit_memory', 'delete', 'block', 'allow', 'refresh_contacts', 'reset_session', 'profile']),
  section: z.enum(['contacts','messages','memories','stickers','tasks','events','actions','turns','capabilities']).default('contacts'),
  chat: z.string().max(64).default(''), query: z.string().max(256).default(''), id: z.string().max(128).default(''),
  text: z.string().max(10000).default(''), expectedText: z.string().max(2000).optional(), blocked: z.boolean().default(true),
  responseMode: z.enum(['inherit','mention','keywords','probability','all']).default('inherit'),
  probability: z.number().int().min(0).max(100).default(10), keywords: z.string().max(1000).default(''), proactive: z.boolean().default(true),
}).strict().refine(value => value.op === 'profile' || value.text.length <= 2000, { message: '记忆内容最多 2000 字', path: ['text'] });

export async function socialAdmin(input: unknown, store: SocialStore, media: MediaService,
  live?: { refresh(): Promise<void>; reset(chat: string): Promise<void> }): Promise<unknown> {
  const a = requestSchema.parse(input);
  if (a.op === 'profile') {
    if (!/^(group|private):\d+$/.test(a.chat)) throw new Error('请选择一个有效会话');
    await store.update(d => {
      const profile = { chat: a.chat, persona: a.text, responseMode: a.responseMode, probability: a.probability, keywords: a.keywords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean), proactive: a.proactive };
      const index = d.profiles.findIndex(p => p.chat === a.chat); if (index < 0) d.profiles.push(profile); else d.profiles[index] = profile;
    });
  }
  if (a.op === 'refresh_contacts') { if (!live) throw new Error('请启动机器人后刷新 QQ 联系人'); await live.refresh(); }
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
    await store.update(d => { const m = d.memories.find(m => m.id === a.id); if (!m) throw new Error('记忆不存在'); if (a.expectedText !== undefined && m.text !== a.expectedText) throw new Error('记忆已被其他操作修改，请刷新后核对；当前编辑仍保留'); m.text = a.text; });
  }
  if (a.op === 'delete') await store.update(d => {
    if (a.section === 'memories') { const m = d.memories.find(m => m.id === a.id); if (!m) throw new Error('记忆不存在'); if (a.expectedText !== undefined && m.text !== a.expectedText) throw new Error('记忆已被其他操作修改，请刷新后核对；当前编辑仍保留'); d.memories = d.memories.filter(m => m.id !== a.id); }
    else if (a.section === 'stickers') d.stickers = d.stickers.filter(s => s.id !== a.id);
    else if (a.section === 'tasks') { const t = d.tasks.find(t => t.id === a.id); if (!t || t.state !== 'pending') throw new Error('只能取消尚未执行的提醒'); t.state = 'cancelled'; }
    else throw new Error('该列表不支持删除');
  });
  const data = store.snapshot(), s = getSettings();
  type Row = { id: string; chat: string; name: string; summary: string; status: string; time: string; detail: string; text: string };
  const date = (at: number) => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
  const rows: Row[] = [];
  const add = (id: string, chat: string, name: string, summary: string, status: string, at: number, detail = summary, text = '') => {
    if (a.op === 'list' && a.chat && chat !== a.chat) return;
    if (a.query && !`${name} ${summary} ${chat} ${a.section === 'memories' ? detail : ''}`.toLowerCase().includes(a.query.toLowerCase())) return;
    rows.push({ id, chat, name, summary: summary.slice(0,160), status, time: date(at), detail, text });
  };
  switch (a.section) {
    case 'contacts': for (const c of data.contacts) {
      const [kind,id] = c.chat.split(':');
      const blocked = (kind === 'group' ? s.social.blockedGroups : s.social.blockedUsers).includes(id);
      add(c.chat, c.chat, c.name, c.chat, blocked ? '已屏蔽' : '可联系', c.at);
    } break;
    case 'messages': for (const m of [...data.messages].reverse()) add(String(m.id), m.chat, m.name, m.text, m.recalled ? '已撤回' : m.self ? '自己发送' : '收到', m.at, `${m.name}（${m.user}）\n消息 #${m.id}\n${m.text}\n\n媒体：${m.segments.filter(s => s.type !== 'text').map(s => s.type).join('、')}`); break;
    case 'memories': for (const m of [...data.memories].reverse()) add(m.id,m.chat,m.name,m.text,'长期记忆',m.at,`QQ ${m.user}\n${m.text}`,m.text); break;
    case 'stickers': for (const t of data.stickers) add(t.id,'',t.note,t.tags.join('、'),`已用 ${t.uses} 次`,t.at,`${t.note}\n标签：${t.tags.join('、')}\n${t.file}`); break;
    case 'tasks': for (const t of [...data.tasks].reverse()) add(t.id,t.chat,t.text,t.error || t.text,{ pending:'等待执行',running:'执行中',sent:'已发送',failed:'失败',unknown:'结果待核对',cancelled:'已取消' }[t.state],t.due,`${t.text}\n${t.error || ''}\n${t.interval ? `每 ${t.interval/60000} 分钟` : '一次性'}`); break;
    case 'events': for (const e of [...data.events].reverse()) add(e.id,e.chat,e.type,String(e.data.comment ?? e.data.sub_type ?? ''),e.handled ? '已处理' : '已记录',e.at,JSON.stringify(e.data,null,2)); break;
    case 'actions': for (const t of [...data.actions].reverse()) {
      const alias: Record<string,string> = { send_message:'qq_send_message', like:'qq_like', qzone_post:'qq_qzone_post' };
      const title = [...socialTools,...legacyTools].find(tool => tool.name === (alias[t.tool] ?? t.tool))?.title ?? t.tool;
      add(t.id,t.chat,title,t.summary,{ running:'执行中',success:'成功',failed:'失败',unknown:'结果待核对' }[t.state],t.at);
    } break;
    case 'turns': for (const t of [...data.turns].reverse()) add(t.id,t.chat,`${Math.round(t.duration/1000)} 秒`,t.output || t.error,t.error ? '失败' : '完成',t.at,`输入：\n${t.input}\n\n输出：\n${t.output}\n\n工具：${t.tools.join('、')}\n${t.error}\n\n用量：${t.inputTokens === null ? 'DSH 未提供' : t.inputTokens + ' 输入 / ' + t.outputTokens + ' 输出'}`); break;
    case 'capabilities': {
      const names: Record<string,string> = { images:'图片理解',transcription:'语音识别',speech:'语音合成',video:'视频理解',search:'联网搜索',qzone:'空间动态' };
      for (const [name,value] of Object.entries(media.capabilities())) add(name,'',names[name] ?? name,value,value.includes('未配置') ? '未配置' : '可检查',0);
      for (const tool of [...socialTools,...legacyTools]) add(tool.name,'',tool.title,tool.description,'已注册',0);
      break;
    }
  }
  return { op: a.op, section: a.section, rows: rows.slice(0,200), total: rows.length, profiles: data.profiles, socialSettings: s.social, note: rows.length ? `显示前 ${Math.min(200,rows.length)} 条；时间为上海时间。` : '暂无记录。启动机器人后接收消息，或刷新联系人。', usage: { turns: data.turns.length, tokensKnown: data.turns.filter(t => t.inputTokens !== null).length } };
}
