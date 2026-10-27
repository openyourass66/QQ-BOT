import { z } from 'zod';
import type { OneBotHttp } from './onebot.js';
import type { BotSettings } from '../core/settings.js';
import { DailyUsageStore, type Quota } from '../core/usage.js';
import { approvalBinding } from '../security/tool-policy.js';

export const QqActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send_message'),
    target_type: z.enum(['private', 'group']),
    target_id: z.number().int().positive().safe(),
    text: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    action: z.literal('like'),
    user_id: z.number().int().positive().safe(),
    times: z.number().int().min(1).max(20),
  }).strict(),
  z.object({
    action: z.literal('qzone_post'),
    text: z.string().min(1).max(2000),
    images: z.array(z.string().min(1).max(4096)).max(9).optional(),
  }).strict(),
]);

export type QqAction = z.infer<typeof QqActionSchema>;

export class QqActionPolicy {
  constructor(
    private readonly api: OneBotHttp,
    private readonly usage: DailyUsageStore,
    private readonly settings: () => BotSettings,
    private readonly confirm: (title: string, signal: AbortSignal) => Promise<boolean>,
    private readonly onMessageSent: () => void = () => undefined,
  ) {}

  async execute(input: unknown, signal: AbortSignal, additionalQuotas: () => Quota[] = () => [], onReserved: () => void = () => undefined): Promise<unknown> {
    const action = QqActionSchema.parse(input);
    signal.throwIfAborted();
    let confirmed = false;
    let checkApproval: (()=>void) | undefined;
    if (action.action === 'qzone_post') {
      const qzone = this.settings().features.qzone;
      if (!qzone.enabled) throw new Error('QQ 空间发布已关闭');
      if (qzone.requireConfirm || this.settings().social.autonomy !== 'autonomous') {
        const binding=approvalBinding(this.settings(),action);
        confirmed = await this.confirm(
          `要发布 QQ 空间说说：\n${action.text}\n图片：\n${action.images?.join('\n') || '(无)'}`, signal,
        );
        if (!confirmed) throw new Error('空间发布未获管理员确认');
        checkApproval=()=>binding.assert(this.settings());
      }
    }

    await this.usage.consume(() => {
      // 审批及等待落盘期间配置可能变化，预扣时重新校验。
      signal.throwIfAborted();
      const settings = this.settings();
      const quotas: Quota[] = [];
      if (action.action === 'qzone_post') {
        if (!settings.features.qzone.enabled) throw new Error('QQ 空间发布已关闭');
        checkApproval?.();
        if ((settings.features.qzone.requireConfirm || settings.social.autonomy !== 'autonomous') && !confirmed) throw new Error('空间发布需要管理员确认，请重试');
        quotas.push({ key: 'qzone', amount: 1, limit: settings.features.qzone.dailyLimit, label: '空间发布' });
      } else if (action.action === 'like') {
        quotas.push({ key: 'likes', amount: action.times, limit: settings.budgets.likesPerDay, label: '点赞' });
      } else {
        quotas.push({ key: 'proactive', amount: 1, limit: settings.budgets.proactiveMessagesPerDay, label: '主动消息' });
        if (action.target_type === 'group') {
          const proactive = settings.chat.group.proactive;
          if (!proactive.enabled) throw new Error('群聊主动发言已关闭');
          quotas.push({ key: `group:${action.target_id}`, amount: 1, limit: proactive.perGroupPerDay, label: '该群主动消息' });
        }
      }
      return [...additionalQuotas(), ...quotas];
    }, onReserved);
    signal.throwIfAborted();
    checkApproval?.();

    if (action.action === 'like') {
      return this.api.call('send_like', { user_id: action.user_id, times: action.times }, signal);
    }
    if (action.action === 'qzone_post') {
      return this.api.call('send_qzone_msg', { content: action.text, images: action.images ?? [] }, signal);
    }
    const result = action.target_type === 'group'
      ? await this.api.sendGroup(action.target_id, action.text, signal)
      : await this.api.sendPrivate(action.target_id, action.text, signal);
    this.onMessageSent();
    return result;
  }
}
