import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseEnv } from 'node:util';
import { runtimeFields, mergeRuntimeEnv, validateRuntimeEnv } from './runtime-fields.mjs';
try { loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const settings = await import('../dist/settings.js');
const read = async (p) => readFile(p, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
const personaPath = resolve(process.env.BOT_WORKSPACE || 'bot-workspace', 'AGENTS.md');
const atomic = async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p + '.desktop.tmp', text, 'utf8'); await rename(p + '.desktop.tmp', p); };
const describeEnv = env => { const values = parseEnv(env); return runtimeFields.map(([group, key, label, fallback, kind]) => ({ group, key, label, kind: kind || 'text', value: values[key] ?? fallback })); };
process.once('message', async ({ action, data }) => {
  try {
    let result;
    if (action === 'load') {
      const env = await read('.env') || await read('.env.example');
      result = { settings: await settings.loadSettings(), env, runtimeFields: describeEnv(env), persona: await read(personaPath), personaPath };
    }
    else if (action === 'settings') result = await settings.saveSettings(data);
    else if (action === 'social') {
      await settings.loadSettings();
      const { SocialStore } = await import('../dist/social-store.js');
      const { MediaService } = await import('../dist/media.js');
      const { socialAdmin } = await import('../dist/social-admin.js');
      const folder = dirname(resolve(process.env.SESSION_STORE || 'data/sessions.json'));
      const store = new SocialStore(process.env.BOT_SOCIAL_STORE || resolve(folder, 'social.json')); await store.load();
      const media = new MediaService(process.env.BOT_MEDIA_DIR || resolve(folder, 'media'), () => settings.getSettings().social);
      result = await socialAdmin(data, store, media);
    }
    else if (action === 'connection') {
      const allowed = new Set(['mediaEnabled', 'visionModel', 'transcriptionModel', 'speechModel', 'speechVoice', 'videoFrames']);
      if (!data?.media || typeof data.media !== 'object' || Array.isArray(data.media) || Object.keys(data.media).some(key => !allowed.has(key))) throw new Error('连接配置格式无效：媒体模型选项无效');
      const previousEnv = await readFile('.env', 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const env = mergeRuntimeEnv(previousEnv || '', data.runtime);
      validateRuntimeEnv(env);
      const previousSettings = await settings.loadSettings();
      const media = Object.fromEntries(Object.entries(data.media).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      const nextSettings = settings.validateSettings({ ...previousSettings, social: { ...previousSettings.social, ...media } });
      if (nextSettings.social.mediaEnabled && ['visionModel', 'transcriptionModel', 'speechModel'].some(key => nextSettings.social[key]) && !parseEnv(env).BOT_MEDIA_BASE_URL?.trim()) throw new Error('连接配置格式无效：使用独立媒体模型前请填写媒体服务地址');
      await atomic(resolve('.env'), env);
      try { await settings.saveSettings(nextSettings); }
      catch (error) {
        if (previousEnv === null) await rm(resolve('.env'), { force: true });
        else await atomic(resolve('.env'), previousEnv);
        throw error;
      }
      result = { env, runtimeFields: describeEnv(env), settings: nextSettings };
    }
    else if (action === 'env' || action === 'runtime') {
      if (action === 'runtime') data = mergeRuntimeEnv(await read('.env'), data);
      validateRuntimeEnv(data);
      await atomic(resolve('.env'), data); result = { env: data, runtimeFields: describeEnv(data) };
    } else if (action === 'persona') {
      if (typeof data?.text !== 'string' || resolve(data.path) !== personaPath) throw new Error('工作区已变更，请重新打开控制台后编辑人设');
      await atomic(personaPath, data.text); result = true;
    }
    else throw new Error('未知配置操作');
    process.send({ ok: true, result }, () => process.disconnect());
  } catch (e) {
    const error = e.issues ? e.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')
      : /工作区已变更|协议无效|配置格式无效/.test(e.message) ? e.message : '配置操作失败，请检查文件格式与访问权限；原有文件保留。';
    process.send({ ok: false, error }, () => process.disconnect());
  }
});
