import { z } from 'zod';
import { StickerAnalysisSchema } from './sticker-review.js';
import type { AutonomousTurn } from '../agent/autonomous-state.js';
import type { TurnBudget } from '../agent/context-policy.js';

const id = z.number().int().safe();
const user = z.number().int().positive().safe();
const short = z.string().min(1).max(2000);
const chat = z.string().regex(/^(group|private):\d+$/);
const empty = {};
export const socialTools = [
  {name:'qq_self_state',title:'查看兴趣与未完想法',description:'查看当前会话的兴趣、未完想法及近期行动摘要。空间独立任务只能查看公开兴趣，不能读取聊天记忆。',schema:empty},
  {name:'qq_interest',title:'记下或调整兴趣',description:'依据实际互动逐渐调整当前会话的兴趣；message_id 使用真实收到的消息。兴趣不跨会话传播。空间任务中只记录公开兴趣。无需每轮更新。',schema:{topic:z.string().trim().min(1).max(80),reason:z.string().trim().min(1).max(300),strength:z.number().int().min(1).max(5).default(3),message_id:id.optional()}},
  {name:'qq_thought',title:'记住、推迟或放弃想法',description:'保存值得以后继续的具体想法；chat 为后续聊天，collect 为看图判断是否收藏。message_id 必须来自当前会话收到的真实消息。空间任务只可保存 qzone 想法。完成由实际工具结果确认，不能自行标记成功。',schema:{op:z.enum(['remember','defer','dismiss']).default('remember'),thought_id:z.string().optional(),kind:z.enum(['chat','collect','qzone']).default('chat'),summary:z.string().trim().min(1).max(200).optional(),reason:z.string().trim().min(1).max(500),message_id:id.optional(),delay_minutes:z.number().min(1).max(10080).default(60),expires_hours:z.number().min(1).max(720).default(72),priority:z.number().int().min(1).max(100).default(50)}},
  { name: 'qq_capabilities', title: '查看可用能力', description: '查看真实启用的 QQ 工具、媒体服务和协议端限制。未配置的能力不可假装成功。', schema: empty },
  { name: 'qq_reply', title: '回复当前会话', description: '向当前群/私聊发送文字，可引用或 @。不扣主动消息额度；成功后本轮不要重复输出同样回答。', schema: { text: z.string().max(4000).default(''), reply_to: id.optional(), at_user: user.optional() } },
  { name: 'qq_recent_messages', title: '查看聊天记录', description: '查看当前会话已收到或主动拉取的历史消息，返回真实消息编号；支持翻页和搜索。', schema: { limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).max(20000).default(0), query: z.string().max(128).default(''), refresh: z.boolean().default(false) } },
  { name: 'qq_message', title: '查看消息详情', description: '读取当前会话里真实存在的消息，包括媒体定位信息。编号取自近期消息工具。', schema: { message_id: id } },
  { name: 'qq_read_forward', title: '展开合并转发', description: '展开当前会话的一条合并转发消息，读取内含文字和媒体信息。', schema: { message_id: id } },
  { name: 'qq_active_members', title: '查看活跃成员', description: '查看最近发言者的 QQ 号、昵称、发言时间及次数。用于准确 @ 和戳一戳。', schema: { limit: z.number().int().min(1).max(50).default(20) } },
  { name: 'qq_chats', title: '查找联系人与群', description: '同步现有好友和群，按名字或 QQ 号查找可联系对象。只能从返回结果选择跨会话发送目标。', schema: { query: z.string().max(128).default(''), limit: z.number().int().min(1).max(100).default(50) } },
  { name: 'qq_poke', title: '戳一戳', description: '戳当前会话中的一位成员；私聊默认对方。受每日动作额度和冷却限制。', schema: { user_id: user.optional() } },
  { name: 'qq_images', title: '查看消息图片', description: '查看当前会话某条消息的图片。优先由 DSH 视觉能力理解，配置独立视觉模型后可代为分析。', schema: { message_id: id, question: short.default('请描述图片内容及与聊天相关的信息') } },
  { name: 'qq_send_image', title: '发送或预览图片', description: '预览或向当前聊天发送图片。source 填网络图片直链或媒体库路径；支持引用和 @。', schema: { source: z.string().min(1).max(4096), preview: z.boolean().default(false), note: z.string().max(2000).default(''), reply_to: id.optional(), at_user: user.optional() } },
  { name: 'qq_stickers', title: '查找 QQ 收藏表情', description: '同步 QQ 账号的收藏表情，按备注、画面、含义、情绪和使用场景查找。仅本地待同步记录不算 QQ 收藏。优先选择已理解且适合当前语境的记录，勿仅看名称。', schema: { query: z.string().max(128).default(''), limit: z.number().int().min(1).max(100).default(24) } },
  { name: 'qq_collect_sticker', title: '看图理解后存入 QQ 收藏', description: '两步收藏：首次返回原图/视觉材料和 analysis_token，尚未收藏；实际分析后带同一 message_id、token 和完整 analysis 再调用，写入 QQ 账号收藏并回读核验后才返回成功。本地仅留缓存与理解，已理解且仍在 QQ 收藏的同图复用原记录。无法看图不得猜测。', schema: { message_id: id, note: short.optional(), tags: z.array(z.string().max(32)).max(20).optional(), analysis_token: z.string().max(64).optional(), analysis: StickerAnalysisSchema.optional() } },
  { name: 'qq_sticker_note', title: '更新表情理解与备注', description: '修改备注不等于已理解图片。完成或重做理解时，先用 qq_sticker_image 获取原图和凭证，再提交完整 analysis；保留原图绑定。', schema: { sticker_id: z.string(), note: short.optional(), tags: z.array(z.string().max(32)).max(20).optional(), analysis_token: z.string().max(64).optional(), analysis: StickerAnalysisSchema.optional() } },
  { name: 'qq_sticker_image', title: '查看和理解表情图片', description: '获取表情原图及分析凭证；根据实际画面与聊天语境理解后，用 qq_sticker_note 提交分析。', schema: { sticker_id: z.string() } },
  { name: 'qq_send_sticker', title: '发送表情', description: '发送已理解且适合当前语境的表情，可引用或 @。旧表情未分析时先返回分析材料（未发送），完成 qq_sticker_note 后再发送；低置信度不发送。', schema: { sticker_id: z.string(), reply_to: id.optional(), at_user: user.optional() } },
  { name: 'qq_memory_append', title: '记录群友印象', description: '按 QQ 号记录值得长期保留的偏好、关系、事实；当前会话隔离，勿记录临时猜测。source_ids 可绑定该用户真实消息作为依据。', schema: { user_id: user, name: z.string().max(128), text: short, source_ids:z.array(id).max(20).optional() } },
  { name: 'qq_memory_query', title: '查询群友记忆', description: '检索当前会话的群友记忆。', schema: { user_id: user.optional(), query: z.string().max(128).default('') } },
  { name: 'qq_memory_remove', title: '删除过时记忆', description: '删除当前会话的一条记忆，ID 从查询工具取得。', schema: { memory_id: z.string() } },
  { name: 'qq_finish', title: '结束或保持话题', description: '决定潜水或结束本轮；reason 只记到管理端，不发到 QQ。active_topic 可维持短时话题参与；end_topic 可退出。', schema: { reason: short, active_topic: z.string().max(100).optional(), end_topic: z.boolean().default(false) } },
  { name: 'qq_set_reminder', title: '安排提醒', description: '在当前会话安排提醒，使用上海时间 YYYY-MM-DD HH:mm 或 delay_minutes；可设周期分钟数。到点实际发送，支持重启恢复。', schema: { text: short, delay_minutes: z.number().min(0.01).max(525600).optional(), at_time: z.string().max(32).optional(), interval_minutes: z.union([z.literal(0), z.number().int().min(5).max(525600)]).default(0) } },
  { name: 'qq_reminders', title: '查看提醒', description: '查看当前会话待执行和失败的提醒。', schema: empty },
  { name: 'qq_cancel_reminder', title: '取消提醒', description: '取消当前会话尚未执行的提醒。', schema: { reminder_id: z.string() } },
  { name: 'qq_events', title: '查看 QQ 事件', description: '查看当前会话的戳一戳、入退群、撤回以及待处理申请；处理申请使用返回的事件 ID。', schema: { pending_only: z.boolean().default(false) } },
  { name: 'qq_actions', title: '核对动作结果', description: '查看当前会话最近的实际动作记录。结果未知时先核对，不要盲目重复执行。', schema: {} },
  { name: 'qq_handle_request', title: '处理好友或群申请', description: '同意/拒绝真实收到的好友申请、群邀请或加群请求。event_id 取自事件列表，禁止猜 flag。', schema: { event_id: z.string(), approve: z.boolean(), remark: z.string().max(128).default('') } },
  { name: 'qq_transcribe', title: '听语音', description: '转写当前会话消息中的语音；需要已配置转写服务，未配置返回不可用。', schema: { message_id: id } },
  { name: 'qq_speak', title: '发送语音', description: '将文字合成为语音并发到当前聊天，需要已配置语音服务。', schema: { text: short } },
  { name: 'qq_video', title: '查看视频', description: '读取消息中的视频，抽帧后理解；需要配置 FFmpeg 及可用视觉能力。', schema: { message_id: id, question: short.default('请概括视频内容') } },
  { name: 'qq_file', title: '接收与读取文件', description: '读取当前消息中的文件，转存到媒体库；文本文件可直接提取内容，其他格式返回文件路径与元信息。', schema: { message_id: id } },
  { name: 'qq_event_file', title: '读取上传事件中的文件', description: '读取 QQ 群上传文件通知中的文件。event_id 从 qq_events 取得。', schema: { event_id: z.string() } },
  { name: 'qq_group_files', title: '浏览当前群文件', description: '查看当前群的根目录或指定文件夹，返回文件名和文件 ID。', schema: { folder_id: z.string().max(256).optional() } },
  { name: 'qq_group_file', title: '读取群文件', description: '下载刚通过 qq_group_files 查到的一个群文件，文本类可提取正文。', schema: { file_id: z.string().min(1).max(512) } },
  { name: 'qq_create_file', title: '制作文本文件', description: '在媒体库生成 UTF-8 文本/Markdown/CSV 文件，可随后用 qq_send_file 发送。', schema: { name: z.string().min(1).max(128).regex(/^[^\\/\x00-\x1f]+\.(txt|md|csv|json)$/i), text: z.string().max(30000) } },
  { name: 'qq_send_file', title: '发送文件', description: '将媒体库中的文件发送到当前聊天。source 可为网络下载地址或受控媒体库路径。', schema: { source: z.string().min(1).max(4096), name: z.string().min(1).max(128).regex(/^[^\\/\x00-\x1f]+$/) } },
  { name: 'qq_qzone_feed', title: '浏览空间', description: '复用 NapCat 当前 QQ 登录读取自己或指定好友的说说，包含正文、图片链接与可回复的评论。留空 user_id 查看自己的空间；好友 QQ 从联系人取得。offset 用于继续读取。', schema: { user_id: user.optional(), limit: z.number().int().min(1).max(20).default(10), offset:z.number().int().min(0).max(2000).default(0) } },
  { name: 'qq_qzone_comment', title: '评论空间', description: '评论当前会话实际读到的说说，或回复返回列表里的评论。post_id、reply_id 必须取自 qq_qzone_feed；编号 30 分钟有效。请求结果不明时先核对，不重复发送。', schema: { post_id: z.string().uuid(), text: z.string().trim().min(1).max(2000), reply_id: z.string().uuid().optional() } },
  { name: 'qq_report', title: '反馈运行问题', description: '将问题记录到管理端，不发送到聊天。', schema: { text: short } },
] satisfies Array<{ name: string; title: string; description: string; schema: z.ZodRawShape }>;

export const SocialCallSchema = z.object({ action: z.literal('social'), tool: z.string().max(64), args: z.record(z.unknown()).default({}) }).strict();
export type SocialCall = z.infer<typeof SocialCallSchema>;
export type ToolContext = { chat: string; self: number; user: number; signal: AbortSignal; sent: number; silent: boolean; topic?: string; endTopic?: boolean; proactive?: boolean; reminder?: boolean; autonomous?:AutonomousTurn; pendingStickerCollections?: Set<string>; pendingStickerSends?: Set<string>; budget?:TurnBudget; messageId?:number };
export const ChatSchema = chat;
