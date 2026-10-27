import { OneBotHttp } from '../dist/qq/onebot.js';
import { resolveCredentialEnv } from '../scripts/credentials.mjs';

const id = value => /^(?:0|[1-9]\d{0,15})$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : undefined;
const fail = text => { throw new Error('配置格式无效：' + text); };
export function scopeBaseline(settings) {
  return { owner: String(settings.approval.adminQq), allowAll: settings.social.allowAll,
    users: [...settings.social.allowedUsers], groups: [...settings.social.allowedGroups] };
}

// 只读取当前连接的实际账号与联系人，不启动模型，不发送消息。
export async function listSetupContacts(env) {
  env=await resolveCredentialEnv(process.cwd(),env);
  const url = new URL(env.ONEBOT_HTTP_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('QQ HTTP 地址无效');
  const bot = new OneBotHttp(url.href.replace(/\/+$/, ''), env.ONEBOT_TOKEN || '');
  const signal = AbortSignal.timeout(7000);
  try {
    const login = await bot.call('get_login_info', {}, signal);
    const account = id(login?.user_id);
    if (!account || account === '0') throw new Error();
    const [friends, groups] = await Promise.all([
      bot.call('get_friend_list', {}, signal), bot.call('get_group_list', {}, signal),
    ]);
    const entries = (values, key, name) => {
      if (!Array.isArray(values) || values.length > 5000) throw new Error();
      const seen = new Set();
      return values.flatMap(value => {
        const keyId = id(value?.[key]);
        if (!keyId || keyId === '0') throw new Error();
        if (seen.has(keyId) || key === 'user_id' && keyId === account) return [];
        seen.add(keyId);
        return [{ id: keyId, name: String(value.remark || value[name] || keyId).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 100) }];
      });
    };
    return { account, friends: entries(friends, 'user_id', 'nickname'), groups: entries(groups, 'group_id', 'group_name') };
  } catch { fail('无法读取 QQ 联系人，请确认已登录、HTTP 地址与令牌正确后重试；原有范围保留。'); }
}

export async function applySetupScope(current, draft, env, readCurrent = async () => current) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(key => !['account','owner','users','groups','baseline'].includes(key))) fail('使用范围草稿无效');
  if (!id(draft.account) || !id(draft.owner)) fail('机器人或主人 QQ 无效');
  for (const key of ['users','groups']) {
    if (!Array.isArray(draft[key]) || draft[key].length > 5000 || draft[key].some(value => typeof value !== 'string' || !id(value) || value === '0')) fail('联系人选择无效');
  }
  const baseline = scopeBaseline(current);
  if (!draft.baseline || Object.keys(baseline).some(key => JSON.stringify(draft.baseline[key]) !== JSON.stringify(baseline[key]))) fail('主人或联系范围已被其他操作修改，请重新读取联系人后核对。');
  const contacts = await listSetupContacts(env);
  current = await readCurrent();
  const latest = scopeBaseline(current);
  if (Object.keys(latest).some(key => JSON.stringify(draft.baseline[key]) !== JSON.stringify(latest[key]))) fail('主人或联系范围已被其他操作修改，请重新读取联系人后核对。');
  if (contacts.account !== draft.account) fail('登录的机器人账号已变化，请重新读取联系人。');
  if (draft.owner === contacts.account) fail('主人应选择自己的 QQ，不能选择机器人账号。');
  const next = structuredClone(current);
  next.social.allowAll = false;
  next.social.allowedUsers = [...new Set(draft.users)];
  next.social.allowedGroups = [...new Set(draft.groups)];
  for (const [key, list, blocked] of [['allowedUsers', contacts.friends, next.social.blockedUsers], ['allowedGroups', contacts.groups, next.social.blockedGroups]]) {
    const available = new Set(list.map(entry => entry.id));
    if (next.social[key].some(value => !available.has(value))) fail('所选联系人已不在当前账号列表中，请重新读取联系人。');
    if (next.social[key].some(value => blocked.includes(value))) fail('所选联系人已被屏蔽，请先在机器人设置中核对屏蔽名单。');
  }
  if (draft.owner !== '0') {
    if (!contacts.friends.some(entry => entry.id === draft.owner) || next.social.blockedUsers.includes(draft.owner)) fail('请选择当前账号未屏蔽的好友作为主人，或暂不设置。');
    if (!next.social.allowedUsers.includes(draft.owner)) next.social.allowedUsers.push(draft.owner);
  }
  if (!next.social.allowedUsers.length && !next.social.allowedGroups.length) fail('请至少选择一位好友或一个群，或选择主人开始私聊。');
  next.approval.adminQq = Number(draft.owner);
  next.installation = { version: 1, scopeConfigured: true };
  return next;
}
