import { socialTools } from "../social-tools.js";
import { isAccountOwner } from "../../core/permissions.js";
import { toolAccessVisible } from "../../security/tool-policy.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function decisionsHandlers(port: Pick<SocialExecutionPort, "autonomy" | "media" | "settings" | "log">): HandlerGroup {
    return { names: ["qq_self_state", "qq_interest", "qq_thought", "qq_capabilities", "qq_finish", "qq_report"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_self_state': return port.autonomy.view(ctx);
                case 'qq_interest': return port.autonomy.interest(ctx, a as never);
                case 'qq_thought': return port.autonomy.thought(ctx, a as never);
                case 'qq_capabilities': return { media: port.media.capabilities(), settings: isAccountOwner(ctx, port.settings().approval.adminQq) ? port.settings().social : Object.fromEntries(Object.entries(port.settings().social).filter(([, value]) => typeof value === 'boolean')), tools: socialTools.filter(t => toolAccessVisible(ctx, port.settings(), t.name)).map(t => ({ name: t.name, description: t.description })), notes: ['消息、成员必须使用真实编号', '本地记录仅包含已收到或主动拉取的消息', '接口成功不等于接收者已阅读'] };
                case 'qq_finish':
                    ctx.silent = true;
                    ctx.topic = a.active_topic;
                    ctx.endTopic = a.end_topic;
                    if (ctx.autonomous)
                        ctx.autonomous.reason = a.reason;
                    port.log(`[decision] ${ctx.chat} ${a.reason}`);
                    return { finished: true };
                case 'qq_report':
                    port.log(`[report] ${ctx.chat} ${a.text}`);
                    return { recorded: true };
                default: throw new Error("未知工具处理器");
            }
        } };
}
