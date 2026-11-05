import { toFile } from "./shared.js";
import { isLibraryImage } from "../../services/image-library.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function mediaHandlers(port: Pick<SocialExecutionPort, "feature" | "message" | "messageImage" | "media" | "send" | "decorators" | "messageSource" | "imageLibrary" | "check">): HandlerGroup {
    return { names: ["qq_images", "qq_save_image", "qq_search_images", "qq_send_image", "qq_transcribe", "qq_speak", "qq_video"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_images': {
                    port.feature('mediaEnabled');
                    const entry = await port.message(ctx, a.message_id);
                    const sources = entry.segments.filter(s => s.type === 'image').slice(0, 4);
                    if (!sources.length)
                        throw new Error('该消息没有图片');
                    const images = [];
                    for (const s of sources)
                        images.push(await port.messageImage(s, ctx));
                    return port.media.vision(images, a.question, ctx.signal);
                }
                case 'qq_save_image': {
                    port.feature('mediaEnabled');
                    if ((a.message_id === undefined) === (a.source === undefined))
                        throw new Error('请在 message_id 和 source 中选择一种图片来源');
                    const message = a.message_id === undefined ? undefined : await port.message(ctx, a.message_id);
                    const segment = message?.segments.filter(s => s.type === 'image')[a.image_index - 1];
                    if (message && (!segment || message.recalled))
                        throw new Error('这条消息已撤回或没有指定序号的图片');
                    const image = segment ? await port.messageImage(segment, ctx) : await port.media.image(a.source, ctx.signal);
                    const source = message ? { chat: ctx.chat, messageId: message.id }
                        : /^https?:\/\//i.test(a.source) ? { url: a.source as string } : { local: true as const };
                    return port.imageLibrary.save(image, { description: a.description, tags: a.tags, source }, () => {
                        port.check(ctx);
                        port.feature('mediaEnabled');
                    });
                }
                case 'qq_search_images':
                    port.feature('mediaEnabled');
                    return port.imageLibrary.search(a.query, a.limit);
                case 'qq_send_image': {
                    port.feature('mediaEnabled');
                    const fromLibrary = isLibraryImage(a.source);
                    if (ctx.autonomous?.kind === 'qzone' && (!a.preview || !fromLibrary))
                        throw new Error('空间任务只能预览库存图，发布请使用 qq_qzone_post');
                    const source = fromLibrary ? port.imageLibrary.path(a.source) : a.source;
                    const image = await port.media.image(source, ctx.signal);
                    if (a.preview)
                        return { content: [image] };
                    const file = await port.media.save(Buffer.from(image.data, 'base64'), '.' + image.mimeType.split('/')[1]);
                    return port.send(ctx, [...await port.decorators(ctx, a), ...(a.note ? [{ type: 'text', data: { text: a.note } }] : []), { type: 'image', data: { file: toFile(file) } }]);
                }
                case 'qq_transcribe':
                    port.feature('mediaEnabled');
                    return port.media.transcribe(await port.messageSource(ctx, a.message_id, 'record'), ctx.signal);
                case 'qq_speak': {
                    port.feature('mediaEnabled');
                    const file = await port.media.speech(a.text, ctx.signal);
                    return port.send(ctx, [{ type: 'record', data: { file: toFile(file) } }]);
                }
                case 'qq_video':
                    port.feature('mediaEnabled');
                    return port.media.video(await port.messageSource(ctx, a.message_id, 'video'), a.question, ctx.signal);
                default: throw new Error("未知工具处理器");
            }
        } };
}
