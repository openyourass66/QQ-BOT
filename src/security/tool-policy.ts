import { createHash } from 'node:crypto';
import type { BotSettings } from '../core/settings.js';
import { isAccountOwner } from '../core/permissions.js';
import type { ToolContext } from '../qq/social-tools.js';

type Access = 'conversation' | 'owner' | 'space';
const conversation = ['qq_self_state','qq_interest','qq_thought','qq_capabilities','qq_reply','qq_recent_messages','qq_message','qq_read_forward','qq_active_members','qq_poke','qq_images','qq_send_image','qq_stickers','qq_collect_sticker','qq_sticker_note','qq_sticker_image','qq_send_sticker','qq_memory_append','qq_memory_query','qq_memory_remove','qq_finish','qq_set_reminder','qq_reminders','qq_cancel_reminder','qq_events','qq_actions','qq_transcribe','qq_speak','qq_video','qq_file','qq_event_file','qq_group_files','qq_group_file','qq_create_file','qq_send_file','qq_report','qq_like','qq_get_group_member_list','qq_recall','qq_self_info'];
const owner = ['qq_chats','qq_send_message','qq_get_friend_list','qq_get_group_list','qq_set_profile','qq_set_group_card','qq_set_avatar','qq_handle_request'];
const space = ['qq_qzone_feed','qq_qzone_comment','qq_qzone_post'];
export const toolAccess: Readonly<Record<string, Access>> = Object.freeze(Object.fromEntries([
  ...conversation.map(name => [name, 'conversation']), ...owner.map(name => [name, 'owner']), ...space.map(name => [name, 'space']),
]) as Record<string, Access>);

export function toolAccessVisible(ctx: ToolContext, settings: BotSettings, name: string): boolean {
  const access = toolAccess[name];
  if (!access) return false;
  if (access === 'conversation') return true;
  if (isAccountOwner(ctx, settings.approval.adminQq)) return true;
  return access === 'space' && (ctx.autonomous?.kind === 'qzone' && name === 'qq_qzone_post' || ctx.autonomous?.kind === 'qzone-comment' && ['qq_qzone_feed','qq_qzone_comment'].includes(name));
}

export function assertToolAccess(ctx: ToolContext, settings: BotSettings, name: string, args: Record<string, unknown> = {}): void {
  if(name==='qq_send_message'&&`${args.target_type}:${args.target_id}`===ctx.chat)return;
  if (!toolAccessVisible(ctx, settings, name)) throw new Error('仅机器人主人或已限定能力的自主任务可执行此操作');
  if (isAccountOwner(ctx, settings.approval.adminQq)) return;
  if (name === 'qq_like' && args.user_id !== ctx.user) throw new Error('普通成员只能给当前发言者点赞');
  if (['qq_get_group_member_list','qq_self_info'].includes(name) && args.group_id !== undefined && ctx.chat !== `group:${args.group_id}`) throw new Error('普通成员只能查询当前群');
}

export function assertTargetAccess(ctx: ToolContext, settings: BotSettings, target: string, actor = false): void {
  if (target === ctx.chat || actor && target === `private:${ctx.user}`) return;
  if (!isAccountOwner(ctx, settings.approval.adminQq)) throw new Error('仅机器人主人可跨会话访问或联系其他对象');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** 一次确认只对本次真实身份、目标和参数有效，设置变化或过期后不能复用。 */
export function approvalBinding(settings: BotSettings, operation: unknown, now: () => number = Date.now) {
  const policy = digest(settings), content = digest(operation), expires = now() + Math.min(settings.approval.timeoutMs, 120000);
  return {
    content,
    assert(current: BotSettings, nextOperation: unknown = operation): void {
      if (now() >= expires || digest(current) !== policy || digest(nextOperation) !== content) throw new Error('确认已过期，或设置、目标、正文发生变化，请重新发起操作');
    },
  };
}

export function approvalDescription(ctx: ToolContext, name: string, args: unknown): string {
  const text = JSON.stringify(args, null, 2);
  return `QQ 操作：${name}\n来源：${ctx.chat}，发起者 QQ ${ctx.user}\n实际参数：\n${text.length > 6000 ? text.slice(0, 6000) + `\n（共 ${text.length} 字符，完整内容摘要 ${digest(args)}）` : text}`;
}
