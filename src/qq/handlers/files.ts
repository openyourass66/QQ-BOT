import { extname } from "node:path";
import { type Segment } from "../onebot.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function filesHandlers(port: Pick<SocialExecutionPort, "feature" | "message" | "media" | "source" | "store" | "api" | "groupFiles" | "serial" | "quota" | "proactiveQuotas" | "onSent">): HandlerGroup {
    return { names: ["qq_file", "qq_event_file", "qq_group_files", "qq_group_file", "qq_create_file", "qq_send_file"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_file': {
                    port.feature('filesEnabled');
                    const entry = await port.message(ctx, a.message_id);
                    const segment = entry.segments.find(s => s.type === 'file');
                    if (!segment)
                        throw new Error('该消息没有文件');
                    const { buffer } = await port.media.bytes(await port.source(segment, ctx), ctx.signal, 25000000);
                    const extension = extname(String(segment.data.name ?? '')).toLowerCase();
                    const file = await port.media.save(buffer, /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin');
                    return { file, bytes: buffer.length, name: segment.data.name, text: ['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html'].includes(extension) ? buffer.toString('utf8').slice(0, 30000) : undefined, note: '当前仅提取文本文件正文；PDF、Word 等二进制文档仅保存文件，不会解析内容。' };
                }
                case 'qq_event_file': {
                    port.feature('filesEnabled');
                    const event = port.store.view('events').events.find(e => e.chat === ctx.chat && e.id === a.event_id && e.type.includes('upload'));
                    if (!event || !event.data.file || typeof event.data.file !== 'object')
                        throw new Error('上传事件不存在或没有文件信息');
                    const fileInfo = event.data.file as Record<string, unknown>;
                    const segment: Segment = { type: 'file', data: { ...fileInfo, file_id: fileInfo.id ?? fileInfo.file_id } };
                    const { buffer } = await port.media.bytes(await port.source(segment, ctx), ctx.signal, 25000000);
                    const ext = extname(String(fileInfo.name ?? '')).toLowerCase();
                    const file = await port.media.save(buffer, /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin');
                    return { file, name: fileInfo.name, bytes: buffer.length, text: ['.txt', '.md', '.csv', '.json'].includes(ext) ? buffer.toString('utf8').slice(0, 30000) : undefined };
                }
                case 'qq_group_files': {
                    port.feature('filesEnabled');
                    if (!ctx.chat.startsWith('group:'))
                        throw new Error('当前不是群聊');
                    const result = await port.api.call<{
                        files?: Array<Record<string, unknown>>;
                    }>(a.folder_id ? 'get_group_files_by_folder' : 'get_group_root_files', { group_id: Number(ctx.chat.split(':')[1]), ...(a.folder_id ? { folder_id: a.folder_id } : {}) }, ctx.signal);
                    port.groupFiles.set(ctx.chat, new Map((result.files ?? []).slice(0, 1000).map(f => [String(f.file_id), f])));
                    if (port.groupFiles.size > 100)
                        port.groupFiles.delete(port.groupFiles.keys().next().value!);
                    return result;
                }
                case 'qq_group_file': {
                    port.feature('filesEnabled');
                    const info = port.groupFiles.get(ctx.chat)?.get(a.file_id);
                    if (!info)
                        throw new Error('请先浏览当前群文件，使用返回的真实文件编号');
                    const source = await port.source({ type: 'file', data: info }, ctx);
                    const { buffer } = await port.media.bytes(source, ctx.signal, 25000000);
                    const extension = extname(String(info.file_name ?? info.name ?? '')).toLowerCase();
                    const file = await port.media.save(buffer, /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin');
                    return { file, name: info.file_name ?? info.name, bytes: buffer.length, text: ['.txt', '.md', '.csv', '.json'].includes(extension) ? buffer.toString('utf8').slice(0, 30000) : undefined };
                }
                case 'qq_create_file': {
                    port.feature('filesEnabled');
                    return { file: await port.media.save(Buffer.from(a.text, 'utf8'), extname(a.name).toLowerCase()), name: a.name };
                }
                case 'qq_send_file': {
                    port.feature('filesEnabled');
                    const { buffer } = await port.media.bytes(a.source, ctx.signal, 25000000);
                    const file = await port.media.save(buffer, extname(a.name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 10) || '.bin');
                    return port.serial(ctx.chat, async () => {
                        await port.quota(ctx, ctx.chat, () => port.proactiveQuotas(ctx, ctx.chat));
                        const [kind, id] = ctx.chat.split(':');
                        let result;
                        try {
                            result = await port.api.call(kind === 'group' ? 'upload_group_file' : 'upload_private_file', { [kind === 'group' ? 'group_id' : 'user_id']: Number(id), file, name: a.name }, ctx.signal);
                        }
                        catch (error) {
                            ctx.silent = true;
                            throw error;
                        }
                        ctx.sent++;
                        port.onSent(ctx.chat, 0, [{ type: 'file', data: { name: a.name } }]);
                        return result;
                    });
                }
                default: throw new Error("未知工具处理器");
            }
        } };
}
