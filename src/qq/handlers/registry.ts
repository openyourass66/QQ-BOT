import type { ToolContext } from '../social-tools.js';
import { socialTools } from '../social-tools.js';
import type { SocialExecutionPort } from '../social-engine.js';
import { conversationHandlers } from './conversation.js';
import { mediaHandlers } from './media.js';
import { stickersHandlers } from './stickers.js';
import { memoryHandlers } from './memory.js';
import { remindersHandlers } from './reminders.js';
import { eventsHandlers } from './events.js';
import { filesHandlers } from './files.js';
import { qzoneHandlers } from './qzone.js';
import { decisionsHandlers } from './decisions.js';
export type ToolHandler = (tool: string, args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
export type HandlerGroup = {
    names: readonly string[];
    execute: ToolHandler;
};
const invalid = (message: string) => Object.assign(new Error('工具策略登记不完整：' + message), { code: 'TOOL_REGISTRY_INVALID' });
export function registerHandlerGroups(groups: HandlerGroup[], expected: readonly string[]): ReadonlyMap<string, ToolHandler> {
    const names = new Set(expected), handlers = new Map<string, ToolHandler>();
    if (names.size !== expected.length)
        throw invalid('工具定义重复');
    for (const group of groups)
        for (const name of group.names) {
            if (!names.has(name))
                throw invalid('处理器没有对应工具定义：' + name);
            if (handlers.has(name))
                throw invalid('处理器重复：' + name);
            handlers.set(name, group.execute);
        }
    for (const name of names)
        if (!handlers.has(name))
            throw invalid('缺少处理器：' + name);
    return handlers;
}
export function createSocialHandlers(port: SocialExecutionPort): ReadonlyMap<string, ToolHandler> {
    return registerHandlerGroups([conversationHandlers(port), mediaHandlers(port), stickersHandlers(port), memoryHandlers(port), remindersHandlers(port), eventsHandlers(port), filesHandlers(port), qzoneHandlers(port), decisionsHandlers(port)], socialTools.map(tool => tool.name));
}
