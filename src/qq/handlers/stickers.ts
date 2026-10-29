import type { SocialData } from "../social-store.js";
import { imageHash, stickerSearchText, stickerInfo, type StickerAnalysis } from "../sticker-review.js";
import { toFile } from "./shared.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function stickersHandlers(port: Pick<SocialExecutionPort, "feature" | "autonomy" | "store" | "message" | "qqStickers" | "messageImage" | "prepareStickerReview" | "serial" | "checkedStickerReview" | "quota" | "stickerReviews" | "settings" | "send" | "decorators">): HandlerGroup {
    return { names: ["qq_stickers", "qq_collect_sticker", "qq_sticker_note", "qq_sticker_image", "qq_send_sticker"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_stickers': {
                    port.feature('stickersEnabled');
                    const used = port.autonomy.stickerRecency(ctx.chat);
                    const terms = a.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
                    const score = (s: SocialData['stickers'][number]) => s.analysis ? { high: 3, medium: 2, low: 1 }[s.analysis.confidence] : 0;
                    return port.store.view('stickers').stickers.filter(s => s.qqPresent && terms.every((term: string) => stickerSearchText(s).includes(term)))
                        .sort((x, y) => score(y) - score(x) || (used.get(x.id) ?? 0) - (used.get(y.id) ?? 0) || x.uses - y.uses).slice(0, a.limit)
                        .map(s => ({ ...stickerInfo(s), lastUsedInChat: used.get(s.id) ?? 0 }));
                }
                case 'qq_collect_sticker': {
                    port.feature('stickersEnabled');
                    const entry = await port.message(ctx, a.message_id);
                    const segment = entry.segments.find(s => s.type === 'image');
                    if (!segment)
                        throw new Error('该消息没有图片');
                    if (Boolean(a.analysis_token) !== Boolean(a.analysis))
                        throw new Error('收藏必须先取得原图分析凭证，再提交完整 analysis，不能只提交备注');
                    if (!a.analysis_token) {
                        await port.qqStickers.sync(ctx.signal);
                        const image = await port.messageImage(segment, ctx), hash = imageHash(Buffer.from(image.data, 'base64'));
                        const existing = port.store.view('stickers').stickers.find(s => s.qqPresent && s.analysis?.imageHash === hash && s.analysis.confidence !== 'low');
                        if (existing) {
                            ctx.pendingStickerCollections?.delete(hash);
                            await port.autonomy.collected(ctx, a.message_id);
                            return { ...stickerInfo(existing), collected: true, reused: true };
                        }
                        return port.prepareStickerReview(ctx, { messageId: a.message_id }, image, a.note, 'collect');
                    }
                    return port.serial('sticker-review:' + a.analysis_token, async () => {
                        const review = await port.checkedStickerReview(ctx, a.analysis_token, { messageId: a.message_id });
                        const analysis: StickerAnalysis = { ...a.analysis, imageHash: review.hash, at: Date.now() };
                        let writeAttempt = false;
                        const favorite = await port.qqStickers.collect(review.file, ctx.signal, async () => { await port.quota(ctx, ctx.chat, () => port.autonomy.collectionQuotas(ctx)); writeAttempt = true; })
                            .catch(error => {
                            if (writeAttempt && ctx.autonomous)
                                ctx.autonomous.failure = String(error);
                            throw error;
                        });
                        const result = await port.store.update(d => {
                            const existing = d.stickers.find(s => s.id === favorite.id);
                            const note = a.note ?? analysis.meaning, tags = [...new Set<string>([...analysis.tags, ...(a.tags ?? [])])].slice(0, 20);
                            if (!existing)
                                throw new Error('QQ 收藏记录已变化，请刷新后核对');
                            existing.note = note;
                            existing.tags = tags;
                            existing.analysis = analysis;
                            return existing;
                        }).catch(error => {
                            if (ctx.autonomous)
                                ctx.autonomous.failure = 'QQ 收藏已写入，理解记录保存失败：' + String(error);
                            throw error;
                        });
                        port.stickerReviews.complete(a.analysis_token);
                        ctx.pendingStickerCollections?.delete(review.hash);
                        await port.autonomy.collected(ctx, a.message_id);
                        return { ...stickerInfo(result), collected: true };
                    });
                }
                case 'qq_sticker_note': {
                    port.feature('stickersEnabled');
                    if (Boolean(a.analysis_token) !== Boolean(a.analysis))
                        throw new Error('更新理解必须先调用 qq_sticker_image 看原图，再提交分析凭证与 analysis');
                    if (!a.analysis_token && a.note === undefined && a.tags === undefined)
                        throw new Error('请填写备注、标签或完整的图片分析');
                    return port.serial('sticker-review:' + (a.analysis_token ?? a.sticker_id), async () => {
                        const review = a.analysis_token ? await port.checkedStickerReview(ctx, a.analysis_token, { stickerId: a.sticker_id }) : undefined;
                        const result = await port.store.update(d => {
                            const s = d.stickers.find(s => s.id === a.sticker_id);
                            if (!s)
                                throw new Error('表情不存在');
                            if (review) {
                                if (s.file !== review.file)
                                    throw new Error('表情图片已变更，请重新看图分析');
                                const analysis: StickerAnalysis = { ...a.analysis, imageHash: review.hash, at: Date.now() };
                                s.analysis = analysis;
                                s.note = a.note ?? (s.note || analysis.meaning);
                                s.tags = [...new Set<string>([...analysis.tags, ...(a.tags ?? s.tags)])].slice(0, 20);
                            }
                            else {
                                if (a.note !== undefined)
                                    s.note = a.note;
                                if (a.tags !== undefined)
                                    s.tags = a.tags;
                            }
                            return s;
                        });
                        if (a.analysis_token)
                            port.stickerReviews.complete(a.analysis_token);
                        return stickerInfo(result);
                    });
                }
                case 'qq_sticker_image':
                case 'qq_send_sticker': {
                    port.feature('stickersEnabled');
                    if (!port.store.view('stickers').stickers.some(s => s.id === a.sticker_id))
                        throw new Error('表情不存在');
                    const image = await port.qqStickers.image(a.sticker_id, ctx.signal), s = port.store.view('stickers').stickers.find(s => s.id === a.sticker_id);
                    if (!s?.qqPresent)
                        throw new Error('表情已从 QQ 收藏移除');
                    if (tool === 'qq_sticker_image' || !s.analysis)
                        return port.prepareStickerReview(ctx, { stickerId: s.id }, image, s.note, tool === 'qq_send_sticker' ? 'send' : 'view');
                    if (imageHash(Buffer.from(image.data, 'base64')) !== s.analysis.imageHash)
                        throw new Error('表情图片与理解记录不一致，请先用 qq_sticker_image 重新分析');
                    if (s.analysis.confidence === 'low')
                        throw new Error('这张表情含义尚不确定，请结合上下文重新看图分析，或选择其他已理解的表情');
                    if (ctx.autonomous && port.autonomy.lastSticker(ctx.chat, s.id) > Date.now() - port.settings().social.stickerRepeatHours * 3600000)
                        throw new Error('这张表情最近已在当前会话使用，请换一张或保持安静');
                    // QQ uses the image subtype to distinguish custom stickers from ordinary pictures.
                    const result = await port.send(ctx, [...await port.decorators(ctx, a), { type: 'image', data: { file: toFile(s.file), sub_type: 1, summary: '[动画表情]' } }]);
                    ctx.pendingStickerSends?.delete(s.id);
                    await port.autonomy.usedSticker(ctx.chat, s.id);
                    await port.store.update(d => {
                        const s = d.stickers.find(s => s.id === a.sticker_id);
                        if (s)
                            s.uses++;
                    });
                    return result;
                }
                default: throw new Error("未知工具处理器");
            }
        } };
}
