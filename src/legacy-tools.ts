import { z } from 'zod';
const user = z.number().int().positive().safe();
export const legacyTools = [
  { name: 'qq_send_message', title: '跨会话发送消息', description: '给指定群或好友发送文字，使用主动额度。回复当前会话优先使用 qq_reply。目标先用 qq_chats 查询，不要猜号码。', schema: { target_type: z.enum(['private','group']), target_id: user, text: z.string().min(1).max(4000) } },
  { name: 'qq_like', title: '名片点赞', description: '给好友名片点赞，按次数扣每日点赞额度。', schema: { user_id: user, times: z.number().int().min(1).max(20).default(1) } },
  { name: 'qq_qzone_post', title: '发布空间说说', description: '发布说说，受空间开关与额度约束；需要协议端支持 send_qzone_msg 扩展。', schema: { text: z.string().min(1).max(2000), images: z.array(z.string().min(1).max(4096)).max(9).optional() } },
  { name: 'qq_get_friend_list', title: '查询好友', description: '查询当前账号好友，过滤屏蔽对象。', schema: {} },
  { name: 'qq_get_group_list', title: '查询群', description: '查询当前账号加入的群，过滤屏蔽对象。', schema: {} },
  { name: 'qq_get_group_member_list', title: '查询群成员', description: '查询已加入群的成员。', schema: { group_id: user } },
  { name: 'qq_set_profile', title: '修改自己的资料', description: '修改自己的昵称、签名等资料。成功后可查询资料核对。', schema: { nickname: z.string().min(1).max(36).optional(), signature: z.string().max(200).optional(), company: z.string().max(100).optional(), email: z.string().max(100).optional(), college: z.string().max(100).optional(), personal_note: z.string().max(500).optional() } },
  { name: 'qq_set_group_card', title: '修改群名片', description: '修改自己在一个已加入群里的名片。', schema: { group_id: user, card: z.string().max(60) } },
  { name: 'qq_set_avatar', title: '修改头像', description: '使用网络图片或机器人媒体库图片更换自己的头像。', schema: { file: z.string().min(1).max(4096) } },
  { name: 'qq_recall', title: '撤回自己的消息', description: '撤回当前会话中本账号真实发送的消息。', schema: { message_id: z.number().int().safe() } },
  { name: 'qq_self_info', title: '查询自己的资料', description: '查看登录昵称与账号、群中名片，核对修改结果。', schema: { group_id: user.optional() } },
] satisfies Array<{ name: string; title: string; description: string; schema: z.ZodRawShape }>;
export const LegacyCallSchema = z.object({ action: z.literal('legacy'), tool: z.string(), args: z.record(z.unknown()).default({}) }).strict();
