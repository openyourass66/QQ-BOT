import { randomUUID } from "node:crypto";
import { isAccountOwner } from "../../core/permissions.js";
import { forgetMemory, memoryMeta, fingerprint } from "../../agent/cognition.js";
import { MemoryMetaSchema } from "../../agent/cognition-state.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function memoryHandlers(port: Pick<SocialExecutionPort, "feature" | "settings" | "store" | "check">): HandlerGroup {
    return { names: ["qq_memory_append", "qq_memory_query", "qq_memory_remove"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_memory_append': {
                    port.feature('memoryEnabled');
                    if (port.settings().social.blockedUsers.includes(String(a.user_id)))
                        throw new Error('目标用户已屏蔽');
                    const sourceIds: number[] = a.source_ids ?? [];
                    for (const id of sourceIds) {
                        const m = await port.store.message(ctx.chat, id);
                        if (m.self || m.recalled || m.user !== a.user_id)
                            throw new Error('记忆依据必须是当前会话中该用户的有效消息');
                    }
                    return port.store.updateWithMessages(ctx.chat, sourceIds, d => {
                        for (const id of sourceIds) {
                            const m = d.messages.find(m => m.chat === ctx.chat && m.id === id);
                            if (!m || m.self || m.recalled || m.user !== a.user_id)
                                throw new Error('记忆来源已失效');
                        }
                        const suppressed = d.cognition.suppressed.find(v => v.chat === ctx.chat && v.hash === fingerprint(a.text));
                        if (suppressed && !sourceIds.some(id => d.messages.some(m => m.chat === ctx.chat && m.id === id && m.at > suppressed.at)))
                            throw new Error('该记忆已删除，需要新的真实依据才能重新记录');
                        const old = d.memories.find(m => m.chat === ctx.chat && m.user === String(a.user_id) && m.text === a.text);
                        if (old)
                            return old;
                        if (d.memories.length >= 10000)
                            throw new Error('长期记忆已满，请整理或删除旧记忆');
                        const m = { id: randomUUID(), chat: ctx.chat, user: String(a.user_id), name: a.name, text: a.text, at: Date.now() };
                        d.memories.push(m);
                        d.cognition.memories[m.id] = MemoryMetaSchema.parse({ source: 'tool', sources: sourceIds, locked: false, confirmedAt: m.at, confidence: sourceIds.length ? 'supported' : 'unknown', evidence: sourceIds.map(id => { const s = d.messages.find(m => m.chat === ctx.chat && m.id === id)!; return { id, user: String(s.user), quote: s.text.slice(0, 500), at: s.at }; }) });
                        return m;
                    });
                }
                case 'qq_memory_query':
                    port.feature('memoryEnabled');
                    return port.store.view('memories').memories.filter(m => m.chat === ctx.chat && (!a.user_id || m.user === String(a.user_id)) && `${m.name} ${m.text}`.includes(a.query) && !port.settings().social.blockedUsers.includes(m.user)).slice(-100);
                case 'qq_memory_remove':
                    port.feature('memoryEnabled');
                    return port.store.update(d => {
                        port.check(ctx);
                        const m = d.memories.find(m => m.chat === ctx.chat && m.id === a.memory_id);
                        if (!m)
                            return { removed: 0 };
                        if (memoryMeta(d, m.id).locked && !isAccountOwner(ctx, port.settings().approval.adminQq))
                            throw new Error('管理员锁定的记忆需要主人真实消息或在管理端修改');
                        forgetMemory(d, m.id);
                        return { removed: 1 };
                    });
                default: throw new Error("未知工具处理器");
            }
        } };
}
