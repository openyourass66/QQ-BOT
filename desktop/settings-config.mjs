import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const mediaKeys = ['mediaEnabled', 'visionModel', 'transcriptionModel', 'speechModel', 'speechVoice', 'videoFrames'];
export const settingsFileFor = (env, inherited = process.env) => resolve((parseEnv(env).BOT_SETTINGS_FILE ?? inherited.BOT_SETTINGS_FILE) || 'bot.config.json');

export function validateMediaService(settings, env) {
  if (settings.social.mediaEnabled && ['visionModel', 'transcriptionModel', 'speechModel'].some(key => settings.social[key]?.trim()) && !parseEnv(env).BOT_MEDIA_BASE_URL?.trim()) {
    throw new Error('配置格式无效：使用独立媒体模型前，请在连接与运行中填写并保存媒体服务地址');
  }
}

export function mergeSettingsDraft(current, baseline, draft, paths) {
  const next = structuredClone(current);
  const get = (value, path) => path.split('.').reduce((node, key) => node?.[key], value);
  for (const path of paths) {
    const before = get(baseline, path), saved = get(current, path), edited = get(draft, path);
    if (before === undefined || edited === undefined || saved === undefined) throw new Error('配置格式无效：设置字段不存在');
    let value = edited;
    if (JSON.stringify(saved) !== JSON.stringify(before) && JSON.stringify(saved) !== JSON.stringify(edited)) {
      if (['social.allowedGroups','social.allowedUsers','social.blockedGroups','social.blockedUsers'].includes(path)) {
        const removed = new Set(before.filter(id => !edited.includes(id)));
        value = [...new Set([...saved.filter(id => !removed.has(id)), ...edited.filter(id => !before.includes(id))])];
      } else throw new Error(`配置格式无效：${path} 已被其他操作修改，当前编辑已保留，请重新打开工作台核对`);
    }
    const parts = path.split('.'), key = parts.pop();
    parts.reduce((node, part) => node[part], next)[key] = value;
  }
  return next;
}
