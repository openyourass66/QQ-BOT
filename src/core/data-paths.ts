import { dirname, resolve,join } from 'node:path';
import {lstatSync} from 'node:fs';

/** 桥接与离线管理共用路径解析，显式覆盖项仍相对于启动目录。 */
export function dataPaths(env: NodeJS.ProcessEnv = process.env, root = process.cwd()) {
  const sessions = resolve(root, env.SESSION_STORE || 'data/sessions.json');
  const folder = dirname(sessions);
  return {
    root:resolve(root),
    sessions,
    groupContext: resolve(root, env.BOT_GROUP_CONTEXT_STORE || resolve(folder, 'group-context.json')),
    usage: resolve(root, env.BOT_USAGE_STORE || resolve(folder, 'daily-usage.json')),
    social: resolve(root, env.BOT_SOCIAL_STORE || resolve(folder, 'social.json')),
    media: resolve(root, env.BOT_MEDIA_DIR || resolve(folder, 'media')),
  };
}

export function mutableDataResources(paths: ReturnType<typeof dataPaths>,allowRecovery=false) {
  if(!allowRecovery){let pending=false;try{lstatSync(join(paths.root,'.restore-journal.json'));pending=true;}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}if(pending)throw Object.assign(new Error('上次恢复尚未收尾，请先在本机维护入口处理恢复中断。'),{code:'MAINTENANCE_RECOVERY_REQUIRED'});}
  return [
    { path: paths.sessions, label: '模型会话映射' },
    { path: paths.sessions+'.sqlite', label: '会话映射数据库' },
    { path: paths.groupContext, label: '群聊上下文' },
    { path: paths.groupContext+'.sqlite', label: '群上下文数据库' },
    { path: paths.usage, label: '每日额度' },
    { path: paths.usage+'.sqlite', label: '额度数据库' },
    { path: paths.social, label: '社交存档' },
    { path: paths.social+'.sqlite', label: '社交数据库' },
    { path: paths.media, label: '媒体目录' },
  ];
}
