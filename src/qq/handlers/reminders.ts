import { isAccountOwner } from "../../core/permissions.js";
import { parseShanghaiTime } from "./shared.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function remindersHandlers(port: Pick<SocialExecutionPort, "feature" | "reminderBlockReason" | "store" | "settings" | "check">): HandlerGroup {
    return { names: ["qq_set_reminder", "qq_reminders", "qq_cancel_reminder"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_set_reminder': {
                    port.feature('remindersEnabled');
                    const blocked = port.reminderBlockReason(ctx, true);
                    if (blocked)
                        throw new Error(`暂不能创建提醒：${blocked}`);
                    if ((a.delay_minutes !== undefined) === (a.at_time !== undefined))
                        throw new Error('delay_minutes 与 at_time 必须且只能提供一项');
                    const due = a.delay_minutes !== undefined ? Date.now() + a.delay_minutes * 60000 : parseShanghaiTime(a.at_time);
                    if (!Number.isFinite(due) || due <= Date.now())
                        throw new Error('提醒时间必须在未来，格式为上海时间 YYYY-MM-DD HH:mm');
                    return port.store.addTask({ chat: ctx.chat, creator: String(ctx.user), text: a.text, due, interval: a.interval_minutes * 60000 });
                }
                case 'qq_reminders': return port.store.view('tasks').tasks.filter(t => t.chat === ctx.chat && (t.creator === String(ctx.user) || isAccountOwner(ctx, port.settings().approval.adminQq)) && !['sent', 'cancelled'].includes(t.state));
                case 'qq_cancel_reminder': return port.store.update(d => {
                    port.check(ctx);
                    const task = d.tasks.find(t => t.id === a.reminder_id && t.chat === ctx.chat);
                    if (!task || !['pending', 'blocked'].includes(task.state))
                        throw new Error('该提醒不存在或已开始执行');
                    if (task.creator !== String(ctx.user) && !isAccountOwner(ctx, port.settings().approval.adminQq))
                        throw new Error('只能取消自己在当前会话创建的提醒');
                    task.state = 'cancelled';
                    return task;
                });
                default: throw new Error("未知工具处理器");
            }
        } };
}
