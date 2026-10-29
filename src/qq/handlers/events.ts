import { assertAccountTool, isAccountOwner } from "../../core/permissions.js";
import { allowedChat } from "../social-settings.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function eventsHandlers(port: Pick<SocialExecutionPort, "settings" | "store" | "operations" | "feature" | "check" | "quota" | "api">): HandlerGroup {
    return { names: ["qq_events", "qq_actions", "qq_handle_request"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_events': {
                    const ownerInbox = isAccountOwner(ctx, port.settings().approval.adminQq) && ctx.chat === `private:${ctx.user}`;
                    return port.store.view('events').events.filter(e => (e.chat === ctx.chat || ownerInbox && e.type.startsWith('request:') && allowedChat(port.settings().social, e.chat)) &&
                        (!e.type.startsWith('request:') || isAccountOwner(ctx, port.settings().approval.adminQq)) && (!a.pending_only || !e.handled)).slice(-50).map(e => ({ ...e, data: Object.fromEntries(Object.entries(e.data).filter(([key]) => !['flag', 'token', 'cookie'].includes(key.toLowerCase()))) }));
                }
                case 'qq_actions': {
                    const current = port.operations ? await port.operations.actions(ctx.self, ctx.chat) : [], ids = new Set(current.map(row => row.id));
                    return [...current, ...port.store.view('actions').actions.filter(action => action.chat === ctx.chat && !ids.has(action.id)).slice(-30).reverse()].sort((a, b) => b.at - a.at).slice(0, 30);
                }
                case 'qq_handle_request': {
                    port.feature('requestsEnabled');
                    const ownerInbox = isAccountOwner(ctx, port.settings().approval.adminQq) && ctx.chat === `private:${ctx.user}`;
                    const event = port.store.view('events').events.find(e => e.id === a.event_id && (e.chat === ctx.chat || ownerInbox) && e.type.startsWith('request:'));
                    if (!event || event.handled || typeof event.data.flag !== 'string')
                        throw new Error('申请不存在或已经处理');
                    port.check(ctx, event.chat);
                    await port.quota(ctx, ctx.chat);
                    await port.store.update(d => {
                        const e = d.events.find(e => e.id === event.id);
                        if (!e || e.handled)
                            throw new Error('申请已由其他操作处理');
                        e.handled = true;
                    });
                    assertAccountTool(ctx, port.settings().approval.adminQq, tool);
                    port.check(ctx, event.chat);
                    return port.api.call(event.type === 'request:friend' ? 'set_friend_add_request' : 'set_group_add_request', { flag: event.data.flag, approve: a.approve, ...(event.type === 'request:friend' ? { remark: a.remark } : { sub_type: event.data.sub_type, reason: a.remark }) }, ctx.signal);
                }
                default: throw new Error("未知工具处理器");
            }
        } };
}
