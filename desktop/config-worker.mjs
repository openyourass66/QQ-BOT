import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseEnv } from 'node:util';
import { runtimeFields, chatRuntimeKeys, initialDefaultKeys, mergeRuntimeEnv, validateRuntimeEnv } from './runtime-fields.mjs';
import { readChatModelConfig, listChatModels, testChatModel } from '../dist/agent/chat-model.js';
import { knowledge } from './knowledge.mjs';
import { mediaKeys, settingsFileFor, validateMediaService, mergeSettingsDraft } from './settings-config.mjs';
try { loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const settings = await import('../dist/core/settings.js');
const read = async (p) => readFile(p, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
const personaPath = resolve(process.env.BOT_WORKSPACE || 'bot-workspace', 'AGENTS.md');
const atomic = async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p + '.desktop.tmp', text, 'utf8'); await rename(p + '.desktop.tmp', p); };
const describeEnv = env => { const values = parseEnv(env); return runtimeFields.map(([group, key, label, fallback, kind]) => ({ group, key, label, initialDefault: initialDefaultKeys.has(key), kind: kind || 'text', value: values[key] ?? fallback })); };
process.once('message', async ({ action, data }) => {
  try {
    let result;
    if (action === 'load') {
      const env = await read('.env') || await read('.env.example');
      const persona = await read(personaPath);
      const library = await knowledge(dirname(personaPath)).catch(error => ({ workspace: dirname(personaPath), global: persona, globalRevision: null, libraryRevision: null, presets: [], files: [], error: /^管理操作失败：/.test(error.message) ? error.message : '无法读取人设与记忆，请检查文件权限后刷新。' }));
      result = { settings: await settings.loadSettings(), settingsPath: settings.getSettingsPath(), env, runtimeFields: describeEnv(env), persona, personaPath, knowledge: library };
    }
    else if (action === 'settings') {
      if (data?.settingsPath && resolve(data.settingsPath) !== settings.getSettingsPath()) throw new Error('配置格式无效：动态配置文件已切换，当前输入已保留，请重新打开工作台核对');
      const next = data?.draft ? mergeSettingsDraft(await settings.loadSettings(), data.baseline, data.draft, data.paths) : data;
      const parsed = settings.validateSettings(next);
      for (const key of mediaKeys) if (typeof parsed.social[key] === 'string') parsed.social[key] = parsed.social[key].trim();
      validateMediaService(parsed, await read('.env'));
      result = await settings.saveSettings(parsed);
    }
    else if (action === 'knowledge') result = await knowledge(dirname(personaPath), data);
    else if (action === 'social') {
      await settings.loadSettings();
      const { SocialStore } = await import('../dist/qq/social-store.js');
      const { MediaService } = await import('../dist/services/media.js');
      const { socialAdmin } = await import('../dist/qq/social-admin.js');
      const folder = dirname(resolve(process.env.SESSION_STORE || 'data/sessions.json'));
      const store = new SocialStore(process.env.BOT_SOCIAL_STORE || resolve(folder, 'social.json')); await store.load();
      const media = new MediaService(process.env.BOT_MEDIA_DIR || resolve(folder, 'media'), () => settings.getSettings().social);
      const { DailyUsageStore } = await import('../dist/core/usage.js');
      const usage = new DailyUsageStore(process.env.BOT_USAGE_STORE || resolve(folder, 'daily-usage.json')); await usage.load();
      result = await socialAdmin(data, store, media, undefined, usage);
    }
    else if (action === 'model') {
      if (!['list', 'test'].includes(data?.operation)) throw new Error('连接配置格式无效：未知模型操作');
      const env = mergeRuntimeEnv(await read('.env'), data.runtime);
      validateRuntimeEnv(env);
      const config = readChatModelConfig(parseEnv(env));
      result = data.operation === 'list'
        ? { operation: 'list', models: await listChatModels(config), message: '模型列表已获取，选择后可测试连接。' }
        : { operation: 'test', ...await testChatModel(config) };
    }
    else if (action === 'connection') {
      if (data?.sourceSettingsPath && resolve(data.sourceSettingsPath) !== settings.getSettingsPath()) throw new Error('配置格式无效：动态配置文件已被其他操作切换，请重新打开工作台核对');
      const allowed = new Set(mediaKeys);
      if (!data?.media || typeof data.media !== 'object' || Array.isArray(data.media) || Object.keys(data.media).some(key => !allowed.has(key))) throw new Error('连接配置格式无效：媒体模型选项无效');
      const previousEnv = await readFile('.env', 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const env = mergeRuntimeEnv(previousEnv || '', data.runtime);
      validateRuntimeEnv(env);
      const targetPath = settingsFileFor(env);
      const switched = targetPath !== settings.getSettingsPath();
      const previousSettings = await settings.readSettingsFile(targetPath);
      if (data.mediaPaths && (!Array.isArray(data.mediaPaths) || data.mediaPaths.some(key => !allowed.has(key)))) throw new Error('配置格式无效：媒体修改字段无效');
      const media = Object.fromEntries(Object.entries(data.media).filter(([key]) => !data.mediaPaths || data.mediaPaths.includes(key)).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      const draftSettings = { ...previousSettings, social: { ...previousSettings.social, ...media } };
      const nextSettings = settings.validateSettings(data.baseline && !switched ? mergeSettingsDraft(previousSettings, data.baseline, draftSettings, Object.keys(media).map(key=>'social.'+key)) : draftSettings);
      validateMediaService(nextSettings, env);
      await atomic(resolve('.env'), env);
      try { await settings.saveSettingsFile(targetPath, nextSettings); }
      catch (error) {
        if (previousEnv === null) await rm(resolve('.env'), { force: true });
        else await atomic(resolve('.env'), previousEnv);
        throw error;
      }
      const before = parseEnv(previousEnv || ''), after = parseEnv(env);
      const onlyModelChanged = runtimeFields.filter(([, key]) => !chatRuntimeKeys.has(key)).every(([, key, , fallback]) => (before[key] ?? fallback) === (after[key] ?? fallback));
      result = { env, runtimeFields: describeEnv(env), settings: nextSettings, settingsPath: targetPath, settingsSwitched: switched, restartAction: onlyModelChanged ? 'restartBridge' : 'restart' };
    }
    else if (action === 'env' || action === 'runtime') {
      const guard = typeof data === 'object' && data !== null && typeof data.text === 'string' ? data : null;
      if (guard) data = guard.text;
      if (action === 'runtime') data = mergeRuntimeEnv(await read('.env'), data);
      validateRuntimeEnv(data);
      const targetPath = settingsFileFor(data);
      if (guard?.hasSettingsDrafts && targetPath !== resolve(guard.settingsPath)) throw new Error('配置格式无效：请先保存机器人设置，再切换动态配置文件');
      const nextSettings = await settings.readSettingsFile(targetPath);validateMediaService(nextSettings, data);
      await atomic(resolve('.env'), data); result = { env: data, runtimeFields: describeEnv(data), settings:nextSettings, settingsPath:targetPath };
    } else if (action === 'persona') {
      if (typeof data?.text !== 'string' || resolve(data.path) !== personaPath) throw new Error('工作区已变更，请重新打开控制台后编辑人设');
      await atomic(personaPath, data.text); result = true;
    }
    else throw new Error('未知配置操作');
    process.send({ ok: true, result }, () => process.disconnect());
  } catch (e) {
    const error = e.issues ? e.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')
      : /工作区已变更|协议无效|配置格式无效|^管理操作失败：/.test(e.message) ? e.message : '配置操作失败，请检查文件格式与访问权限；原有文件保留。';
    process.send({ ok: false, error }, () => process.disconnect());
  }
});
