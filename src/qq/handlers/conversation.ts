import { allowedChat } from "../social-settings.js";
import { parseMessageEvent, segmentsToText, type Segment } from "../onebot.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function conversationHandlers(port: Pick<SocialExecutionPort, "send" | "decorators" | "api" | "settings" | "store" | "message" | "contacts" | "quota">): HandlerGroup {
    return { names: ["qq_reply", "qq_recent_messages", "qq_message", "qq_read_forward", "qq_active_members", "qq_chats", "qq_poke"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_reply': {
                    if (!a.text)
                        throw new Error('文字不能为空；只想潜水请调用 qq_finish');
                    return port.send(ctx, [...await port.decorators(ctx, a), { type: 'text', data: { text: a.text } }]);
                }
                case 'qq_recent_messages': {
                    if (a.refresh) {
                        const [kind, id] = ctx.chat.split(':');
                        const result = await port.api.call<{
                            messages: unknown[];
                        }>(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', { [kind === 'group' ? 'group_id' : 'user_id']: Number(id), count: a.limit, message_seq: 0 }, ctx.signal);
                        if (!Array.isArray(result.messages))
                            throw new Error('协议端不支持历史查询或返回格式异常');
                        for (const raw of result.messages) {
                            const entry = raw as Record<string, unknown>;
                            const ev = parseMessageEvent({ ...entry, post_type: 'message', message_type: kind, self_id: ctx.self, ...(kind === 'group' ? { group_id: Number(id) } : {}), sender: entry.sender ?? {} });
                            if (ev && !port.settings().social.blockedUsers.includes(String(ev.user_id))) {
                                await port.store.add({ chat: ctx.chat, id: ev.message_id, user: ev.user_id, name: ev.sender.card || ev.sender.nickname, at: ev.time * 1000, text: segmentsToText(ev.message), segments: ev.message, self: ev.user_id === ctx.self, recalled: false });
                            }
                        }
                    }
                    return (await port.store.messages(ctx.chat, a.limit, a.offset, a.query)).filter(m => !port.settings().social.blockedUsers.includes(String(m.user)));
                }
                case 'qq_message': return await port.message(ctx, a.message_id);
                case 'qq_read_forward': {
                    const entry = await port.message(ctx, a.message_id);
                    const segment = entry.segments.find(s => s.type === 'forward');
                    if (!segment)
                        throw new Error('该消息不是合并转发');
                    const result = await port.api.call<Record<string, unknown>>('get_forward_msg', { message_id: String(segment.data.id ?? a.message_id) }, ctx.signal);
                    const media: Segment[] = [];
                    const walk = (value: unknown, depth = 0): void => {
                        if (!value || depth > 5 || media.length > 30)
                            return;
                        if (Array.isArray(value)) {
                            for (const node of value.slice(0, 100))
                                walk(node, depth + 1);
                            return;
                        }
                        if (typeof value !== 'object')
                            return;
                        const node = value as Record<string, unknown>;
                        if (['image', 'record', 'video', 'file'].includes(String(node.type)) && node.data && typeof node.data === 'object')
                            media.push(node as unknown as Segment);
                        for (const key of ['content', 'message', 'messages', 'data'])
                            if (node[key] && node[key] !== value)
                                walk(node[key], depth + 1);
                    };
                    walk(result);
                    if (media.length)
                        await port.store.updateWithMessages(ctx.chat, [a.message_id], d => {
                            const original = d.messages.find(m => m.chat === ctx.chat && m.id === a.message_id);
                            if (original)
                                original.segments = original.segments.filter(s => s.type === 'forward').concat(media);
                        });
                    return result;
                }
                case 'qq_active_members': {
                    const members = new Map<number, {
                        user_id: number;
                        name: string;
                        last_at: number;
                        count: number;
                    }>();
                    for (const m of await port.store.messages(ctx.chat, 2000)) {
                        if (port.settings().social.blockedUsers.includes(String(m.user)))
                            continue;
                        const old = members.get(m.user);
                        members.set(m.user, { user_id: m.user, name: m.name, last_at: Math.max(old?.last_at ?? 0, m.at), count: (old?.count ?? 0) + 1 });
                    }
                    return [...members.values()].sort((x, y) => y.last_at - x.last_at).slice(0, a.limit);
                }
                case 'qq_chats': {
                    await port.contacts(ctx.signal, true);
                    return port.store.view('contacts').contacts.filter(c => allowedChat(port.settings().social, c.chat) && `${c.name} ${c.chat}`.includes(a.query)).sort((x, y) => y.at - x.at).slice(0, a.limit);
                }
                case 'qq_poke': {
                    const [kind, id] = ctx.chat.split(':');
                    const target = a.user_id ?? (kind === 'private' ? Number(id) : undefined);
                    if (kind === 'private' && target !== Number(id))
                        throw new Error('私聊戳一戳只能操作当前私聊对象');
                    if (!target || port.settings().social.blockedUsers.includes(String(target)))
                        throw new Error('请指定当前群里未屏蔽的成员');
                    if (kind === 'group')
                        await port.decorators(ctx, { at_user: target });
                    await port.quota(ctx, ctx.chat);
                    return port.api.call(kind === 'group' ? 'group_poke' : 'friend_poke', { ...(kind === 'group' ? { group_id: Number(id) } : {}), user_id: target }, ctx.signal);
                }
                default: throw new Error("未知工具处理器");
            }
        } };
}
