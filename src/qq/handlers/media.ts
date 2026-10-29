import { toFile } from "./shared.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function mediaHandlers(port: Pick<SocialExecutionPort, "feature" | "message" | "messageImage" | "media" | "send" | "decorators" | "messageSource">): HandlerGroup {
    return { names: ["qq_images", "qq_send_image", "qq_transcribe", "qq_speak", "qq_video"], execute: async (tool, a, ctx) => {
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
                case 'qq_send_image': {
                    port.feature('mediaEnabled');
                    const image = await port.media.image(a.source, ctx.signal);
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
