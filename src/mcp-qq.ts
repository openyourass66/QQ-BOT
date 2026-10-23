import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OneBotHttp } from './onebot.js';
import { requestQqAction } from './action-client.js';

/**
 * QQ 动作 MCP 服务：由 DSH 通过 dsh-mcp-client 以 stdio 方式拉起。
 * 模型看到的是 mcp__qq__<tool>，每个工具都必须做参数校验。
 */
const api = new OneBotHttp(
  process.env.ONEBOT_HTTP_URL ?? 'http://127.0.0.1:3000',
  process.env.ONEBOT_TOKEN ?? '',
);

const server = new McpServer({ name: 'qq', version: '1.0.0' });

const ok = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});

server.registerTool(
  'qq_send_message',
  {
    title: '发送 QQ 消息',
    description:
      '给指定私聊或群聊发送一条文本消息，受主动消息每日额度约束；群聊还需开启主动发言并满足单群额度。仅在需要主动私聊别人、或把消息发到当前对话之外时使用；回复当前对话请直接输出文本。',
    inputSchema: {
      target_type: z.enum(['private', 'group']).describe('private=私聊，group=群聊'),
      target_id: z.number().int().positive().describe('私聊填 QQ 号，群聊填群号'),
      text: z.string().min(1).max(4000).describe('消息正文，纯文本'),
    },
  },
  async ({ target_type, target_id, text }, extra) => {
    try {
      return ok(await requestQqAction({ action: 'send_message', target_type, target_id, text }, extra.signal));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_get_friend_list',
  {
    title: '获取好友列表',
    description: '返回机器人的 QQ 好友列表（QQ 号、昵称、备注）。',
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api.call('get_friend_list'));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_get_group_list',
  {
    title: '获取群列表',
    description: '返回机器人加入的 QQ 群列表（群号、群名、人数）。',
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api.call('get_group_list'));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_get_group_member_list',
  {
    title: '获取群成员',
    description: '返回指定群的成员列表（QQ 号、群名片、昵称、角色）。',
    inputSchema: {
      group_id: z.number().int().positive().describe('群号'),
    },
  },
  async ({ group_id }) => {
    try {
      return ok(await api.call('get_group_member_list', { group_id }));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_set_profile',
  {
    title: '修改自己的资料',
    description:
      '修改机器人自己的 QQ 资料：昵称、个性签名、公司、邮箱、学校、个人说明。只传想改的字段。',
    inputSchema: {
      nickname: z.string().min(1).max(36).optional().describe('昵称'),
      signature: z.string().max(200).optional().describe('个性签名'),
      company: z.string().max(100).optional().describe('公司'),
      email: z.string().max(100).optional().describe('邮箱'),
      college: z.string().max(100).optional().describe('学校'),
      personal_note: z.string().max(500).optional().describe('个人说明'),
    },
  },
  async (input) => {
    const profile: Record<string, unknown> = {};
    if (input.nickname) profile.nickname = input.nickname;
    if (input.company) profile.company = input.company;
    if (input.email) profile.email = input.email;
    if (input.college) profile.college = input.college;
    if (input.personal_note) profile.personal_note = input.personal_note;

    const results: Record<string, unknown> = {};
    try {
      if (Object.keys(profile).length > 0) {
        results.profile = await api.call('set_qq_profile', profile);
      }
      if (input.signature) {
        results.signature = await api.call('set_self_longnick', { longNick: input.signature });
      }
      return ok(Object.keys(results).length ? results : '没有需要修改的字段');
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_set_group_card',
  {
    title: '修改群名片',
    description: '修改机器人在某个群里的群名片。',
    inputSchema: {
      group_id: z.number().int().positive().describe('群号'),
      card: z.string().max(60).describe('新的群名片'),
    },
  },
  async ({ group_id, card }) => {
    try {
      const self = await api.call<{ user_id: number }>('get_login_info');
      return ok(await api.call('set_group_card', { group_id, user_id: self.user_id, card }));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_set_avatar',
  {
    title: '更换头像',
    description: '更换机器人 QQ 头像。file 支持本地绝对路径、URL 或 base64://。',
    inputSchema: {
      file: z.string().min(1).describe('图片路径 / URL / base64'),
    },
  },
  async ({ file }) => {
    try {
      return ok(await api.call('set_qq_avatar', { file }));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_like',
  {
    title: '给好友点赞',
    description: '给指定好友的名片点赞，按实际点赞次数扣除每日额度。',
    inputSchema: {
      user_id: z.number().int().positive().describe('QQ 号'),
      times: z.number().int().min(1).max(20).default(1).describe('点赞次数'),
    },
  },
  async ({ user_id, times }, extra) => {
    try {
      return ok(await requestQqAction({ action: 'like', user_id, times }, extra.signal));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_qzone_post',
  {
    title: '发表 QQ 空间说说',
    description:
      '发布一条 QQ 空间说说，可带图片。需开启空间功能并满足每日额度；开启 requireConfirm 时由桥接服务请求管理员确认正文和图片。依赖 NapCat 的 send_qzone_msg 扩展动作。',
    inputSchema: {
      text: z.string().min(1).max(2000).describe('说说正文'),
      images: z.array(z.string().min(1).max(4096)).max(9).optional().describe('图片路径 / URL 列表'),
    },
  },
  async ({ text, images }, extra) => {
    try {
      return ok(await requestQqAction({ action: 'qzone_post', text, images }, extra.signal));
    } catch (error) {
      return fail(`发送说说失败：${String(error)}`);
    }
  },
);

server.registerTool(
  'qq_get_cookies',
  {
    title: '获取站点 Cookie',
    description:
      '获取指定域名的登录 Cookie（例如 qzone.qq.com）。属于敏感数据，不要发到聊天里。',
    inputSchema: {
      domain: z.string().min(1).describe('域名，例如 qzone.qq.com'),
    },
  },
  async ({ domain }) => {
    try {
      return ok(await api.call('get_cookies', { domain }));
    } catch (error) {
      return fail(String(error));
    }
  },
);

server.registerTool(
  'qq_recall',
  {
    title: '撤回消息',
    description: '撤回机器人自己发送的一条消息。',
    inputSchema: {
      message_id: z.number().int().positive().describe('消息 ID'),
    },
  },
  async ({ message_id }) => {
    try {
      return ok(await api.call('delete_msg', { message_id }));
    } catch (error) {
      return fail(String(error));
    }
  },
);

await server.connect(new StdioServerTransport());
console.error('[mcp-qq] ready');
