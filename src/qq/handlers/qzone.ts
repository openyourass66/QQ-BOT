import { approvalBinding } from "../../security/tool-policy.js";
import type { SocialExecutionPort } from "../social-engine.js";
import type { HandlerGroup } from "./registry.js";
export function qzoneHandlers(port: Pick<SocialExecutionPort, "settings" | "autonomy" | "spaceTarget" | "qzone" | "check" | "confirm" | "quota">): HandlerGroup {
    return { names: ["qq_qzone_feed", "qq_qzone_comment"], execute: async (tool, a, ctx) => {
            switch (tool) {
                case 'qq_qzone_feed': {
                    if (!port.settings().features.qzone.browseEnabled)
                        throw new Error('空间浏览已关闭，请在机器人设置的功能开关开启');
                    const user = a.user_id ?? ctx.self;
                    port.autonomy.authorizeSpaceTarget(ctx, user);
                    if (user !== ctx.self)
                        await port.spaceTarget(ctx, user);
                    const result = await port.qzone.feed(ctx.chat, ctx.self, user, a.limit, a.offset, ctx.signal);
                    port.check(ctx);
                    if (!port.settings().features.qzone.browseEnabled)
                        throw new Error('空间浏览已关闭');
                    if (user !== ctx.self)
                        port.check(ctx, `private:${user}`);
                    return result;
                }
                case 'qq_qzone_comment': {
                    let confirmed = false;
                    const validate = () => {
                        port.check(ctx);
                        const qzone = port.settings().features.qzone;
                        if (!qzone.browseEnabled || !qzone.commentsEnabled)
                            throw new Error('空间浏览或评论已关闭，请在机器人设置的功能开关开启');
                        const target = port.qzone.target(ctx.chat, ctx.self, a.post_id, a.reply_id);
                        port.autonomy.authorizeSpaceTarget(ctx, target.post.user_id, a.post_id);
                        if (target.post.user_id !== ctx.self)
                            port.check(ctx, `private:${target.post.user_id}`);
                        return { qzone, target };
                    };
                    const { qzone, target } = validate();
                    if (target.post.user_id !== ctx.self)
                        await port.spaceTarget(ctx, target.post.user_id);
                    let checkApproval: (() => void) | undefined;
                    if (qzone.commentRequireConfirm || port.settings().social.autonomy !== 'autonomous') {
                        const binding = approvalBinding(port.settings(), { tool, chat: ctx.chat, user: ctx.user, target: target.post.url, args: a });
                        confirmed = await port.confirm(`要${target.reply ? '回复空间评论' : '评论 QQ 空间说说'}：\n目标：${target.post.name || target.post.user_id}（QQ ${target.post.user_id}）\n动态：${target.post.text.slice(0, 800)}\n${target.reply ? '回复 ' + (target.reply.name || target.reply.user_id) + '：' + target.reply.text + '\n' : ''}评论正文：\n${a.text}`, ctx.signal);
                        if (!confirmed)
                            throw new Error('空间评论未获管理员确认');
                        checkApproval = () => binding.assert(port.settings());
                    }
                    let reserved = false;
                    try {
                        const result = await port.qzone.comment(ctx.chat, ctx.self, { post_id: a.post_id, text: a.text, reply_id: a.reply_id }, ctx.signal, async () => {
                            const check = () => {
                                const { qzone } = validate();
                                if ((qzone.commentRequireConfirm || port.settings().social.autonomy !== 'autonomous') && !confirmed)
                                    throw new Error('空间评论现在需要管理员确认，请重新发起');
                                checkApproval?.();
                                return qzone;
                            };
                            check();
                            await port.quota(ctx, ctx.chat, () => [{ key: 'qzone-comments', amount: 1, limit: check().commentDailyLimit, label: '空间评论' }]);
                            check();
                            await port.autonomy.reserveSpaceComment(ctx, target.post.url);
                            reserved = true;
                            check();
                        });
                        await port.autonomy.finishSpaceComment(ctx, target.post.url, true);
                        return result;
                    }
                    catch (error) {
                        if (reserved)
                            await port.autonomy.finishSpaceComment(ctx, target.post.url, false);
                        throw error;
                    }
                }
                default: throw new Error("未知工具处理器");
            }
        } };
}
