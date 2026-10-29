import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { existsSync } from 'node:fs';
import { setup } from '../scripts/setup.mjs';
import { detectEnvironment, checkSetup } from './onboarding.mjs';
import { listSetupContacts, applySetupScope, scopeBaseline } from './setup-scope.mjs';
import { resolveCredentialEnv, protectEnvironmentText } from '../scripts/credentials.mjs';
import { runtimeFields, chatRuntimeKeys, initialDefaultKeys, mergeRuntimeEnv, validateRuntimeEnv } from './runtime-fields.mjs';
import { readChatModelConfig, listChatModels, testChatModel } from '../dist/agent/chat-model.js';
import { knowledge } from './knowledge.mjs';
import { mediaKeys, settingsFileFor, validateMediaService, mergeSettingsDraft } from './settings-config.mjs';
import { dataPaths, mutableDataResources } from '../dist/core/data-paths.js';
import { acquireDataResources } from '../dist/core/resource-lock.js';
const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if ((existsSync('.env.example') || process.env.BOT_DATA_DIR) && existsSync(join(programRoot, '.env.example')) && existsSync(join(programRoot, 'templates/bot-persona.md'))) await setup(programRoot, process.cwd());
try { Object.assign(process.env, parseEnv(await readFile('.env', 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const settings = await import('../dist/core/settings.js');
const read = async (p) => readFile(p, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
const personaPath = resolve(process.env.BOT_WORKSPACE || 'bot-workspace', 'AGENTS.md');
const atomic = async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p + '.desktop.tmp', text, 'utf8'); await rename(p + '.desktop.tmp', p); };
const describeEnv = async env => { const raw=parseEnv(env),values = await resolveCredentialEnv(process.cwd(),raw,{allowUnavailable:true}); return runtimeFields.map(([group, key, label, fallback, kind]) => ({ group, key, label, initialDefault: initialDefaultKeys.has(key), kind: kind || 'text', value: values[key] ?? fallback,credentialUnavailable:Boolean(raw[key]?.startsWith('@whale-credential:')&&!values[key]) })); };
process.once('message', async ({ action, data }) => {
  let dataLease;
  let configurationLease;
  let settingsLease;
  try {
    if(['connection','env','runtime'].includes(action))configurationLease=await acquireDataResources([{path:resolve('.env'),label:'连接配置'}]);
    let result;
    if (action === 'load') {
      const env = await read('.env') || await read('.env.example');
      const persona = await read(personaPath);
      const library = await knowledge(dirname(personaPath)).catch(error => ({ workspace: dirname(personaPath), global: persona, globalRevision: null, libraryRevision: null, presets: [], files: [], error: /^管理操作失败：/.test(error.message) ? error.message : '无法读取人设与记忆，请检查文件权限后刷新。' }));
      const values = parseEnv(env);
      const loaded = await settings.loadSettings();
      result = { settings: loaded, settingsPath: settings.getSettingsPath(), env, runtimeFields: await describeEnv(env), persona, personaPath, knowledge: library, needsSetup: !values.BOT_DSH_BIN || values.BOT_DSH_BIN === 'dsh.cmd' || loaded.installation?.scopeConfigured === false };
    }
    else if (action === 'qq-prepare') {
      if(data?.shell!==undefined&&typeof data.shell!=='string')throw new Error('QQ 组件路径无效');
      const {ManagedQQ}=await import('../scripts/qq-runtime.mjs');
      result=await new ManagedQQ({root:programRoot,dataRoot:process.cwd()}).prepare(data?.shell);
    }
    else if (action === 'onboarding') {
      if (!['detect','check','contacts'].includes(data?.operation)) throw new Error('连接配置格式无效：未知快速配置操作');
      const env = mergeRuntimeEnv(await read('.env'), data.runtime || {});
      if (data.operation === 'contacts') {
        const current = await settings.readSettingsFile(settingsFileFor(env));
        result = { operation: 'contacts', requestId: data.requestId, ...await listSetupContacts(parseEnv(env)), baseline: scopeBaseline(current) };
      } else {
        if (data.operation === 'check') validateRuntimeEnv(env);
        result = data.operation === 'detect' ? await detectEnvironment(process.cwd(), { ...process.env, ...parseEnv(env) }) : await checkSetup(programRoot, parseEnv(env), { dataRoot: process.cwd() });
      }
    }
    else if (action === 'settings') {
      if (data?.settingsPath && resolve(data.settingsPath) !== settings.getSettingsPath()) throw new Error('配置格式无效：动态配置文件已切换，当前输入已保留，请重新打开工作台核对');
      settingsLease = await acquireDataResources([{path:settings.getSettingsPath(),label:'机器人设置'}]);
      const next = data?.draft ? mergeSettingsDraft(await settings.loadSettings(), data.baseline, data.draft, data.paths) : data;
      const parsed = settings.validateSettings(next);
      for (const key of mediaKeys) if (typeof parsed.social[key] === 'string') parsed.social[key] = parsed.social[key].trim();
      validateMediaService(parsed, await read('.env'));
      result = await settings.saveSettings(parsed);
    }
    else if (action === 'knowledge') result = await knowledge(dirname(personaPath), data);
    else if (action === 'social') {
      const paths = dataPaths();
      dataLease = await acquireDataResources(mutableDataResources(paths));
      await settings.loadSettings();
      const { SqliteSocialStore } = await import('../dist/storage/sqlite-social-store.js');
      const { MediaService } = await import('../dist/services/media.js');
      const { socialAdmin } = await import('../dist/qq/social-admin.js');
      const store = new SqliteSocialStore(paths.social,{onMigrationProgress:process.env.BOT_CONFIG_PROGRESS==='1'?progress=>process.send?.({type:'storage-progress',...progress}):undefined}); await store.load();
      try {
      const media = new MediaService(paths.media, () => settings.getSettings().social);
      const { SqliteDailyUsageStore } = await import('../dist/storage/sqlite-usage-store.js');
      const usage = new SqliteDailyUsageStore(paths.usage);
      try {await usage.load();
      result = await socialAdmin(data, store, media, undefined, usage);
      } finally {await usage.close();}
      } finally {await store.close();}
    }
    else if (action === 'model') {
      if (!['list', 'test'].includes(data?.operation)) throw new Error('连接配置格式无效：未知模型操作');
      const env = mergeRuntimeEnv(await read('.env'), data.runtime);
      validateRuntimeEnv(env);
      const config = readChatModelConfig(await resolveCredentialEnv(process.cwd(),parseEnv(env)));
      result = data.operation === 'list'
        ? { operation: 'list', models: await listChatModels(config), message: '模型列表已获取，选择后可测试连接。' }
        : { operation: 'test', ...await testChatModel(config) };
    }
    else if(action==='qzone-check') {
      const runtime=data?.runtime??{};
      if(!runtime||typeof runtime!=='object'||Array.isArray(runtime)||Object.keys(runtime).some(key=>!['ONEBOT_HTTP_URL','ONEBOT_TOKEN'].includes(key)))throw new Error('连接配置格式无效：空间检查只接受 QQ HTTP 地址和连接令牌');
      const env=await resolveCredentialEnv(process.cwd(),{...process.env,...parseEnv(mergeRuntimeEnv(await read('.env'),runtime))});
      const url=new URL(env.ONEBOT_HTTP_URL||'http://127.0.0.1:3000');
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('连接配置格式无效：QQ HTTP 地址无效');
      const {OneBotHttp}=await import('../dist/qq/onebot.js');const {QzoneService}=await import('../dist/services/qzone.js');
      const signal=AbortSignal.timeout(25000);
      try {result=await new QzoneService(new OneBotHttp(url.href.replace(/\/+$/,''),env.ONEBOT_TOKEN??'')).inspect(signal);}
      catch(error){throw new Error('空间连接检查失败：'+(signal.aborted?'检查超时，请确认 QQ 在线并检查网络。':error.message));}
    }
    else if (action === 'connection') {
      if (data?.sourceSettingsPath && resolve(data.sourceSettingsPath) !== settings.getSettingsPath()) throw new Error('配置格式无效：动态配置文件已被其他操作切换，请重新打开工作台核对');
      const allowed = new Set(mediaKeys);
      if (!data?.media || typeof data.media !== 'object' || Array.isArray(data.media) || Object.keys(data.media).some(key => !allowed.has(key))) throw new Error('连接配置格式无效：媒体模型选项无效');
      const previousEnv = await readFile('.env', 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      let env = mergeRuntimeEnv(previousEnv || '', data.runtime);
      validateRuntimeEnv(env);
      const targetPath = settingsFileFor(env);
      const switched = targetPath !== settings.getSettingsPath();
      settingsLease = await acquireDataResources([{path:targetPath,label:'机器人设置'}]);
      const previousSettings = await settings.readSettingsFile(targetPath);
      if (data.mediaPaths && (!Array.isArray(data.mediaPaths) || data.mediaPaths.some(key => !allowed.has(key)))) throw new Error('配置格式无效：媒体修改字段无效');
      const media = Object.fromEntries(Object.entries(data.media).filter(([key]) => !data.mediaPaths || data.mediaPaths.includes(key)).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      const draftSettings = { ...previousSettings, social: { ...previousSettings.social, ...media } };
      let nextSettings = settings.validateSettings(data.baseline && !switched ? mergeSettingsDraft(previousSettings, data.baseline, draftSettings, Object.keys(media).map(key=>'social.'+key)) : draftSettings);
      if (data.scope) nextSettings = settings.validateSettings(await applySetupScope(nextSettings, data.scope, parseEnv(env), async () => {
        const latest = await settings.readSettingsFile(targetPath);
        return data.baseline && !switched ? mergeSettingsDraft(latest, data.baseline, { ...latest, social: { ...latest.social, ...media } }, Object.keys(media).map(key=>'social.'+key)) : { ...latest, social: { ...latest.social, ...media } };
      }));
      else if (data.restart && nextSettings.installation?.scopeConfigured === false) throw new Error('配置格式无效：请先在快速配置中选择主人和联系范围，再保存并启动。');
      validateMediaService(nextSettings, env);
      env=await protectEnvironmentText(process.cwd(),env,previousEnv||'');
      await atomic(resolve('.env'), env);
      try { await settings.saveSettingsFile(targetPath, nextSettings); }
      catch (error) {
        if (previousEnv === null) await rm(resolve('.env'), { force: true });
        else await atomic(resolve('.env'), previousEnv);
        throw error;
      }
      const before = parseEnv(previousEnv || ''), after = parseEnv(env);
      const onlyModelChanged = runtimeFields.filter(([, key]) => !chatRuntimeKeys.has(key)).every(([, key, , fallback]) => (before[key] ?? fallback) === (after[key] ?? fallback));
      result = { env, runtimeFields: await describeEnv(env), settings: nextSettings, settingsPath: targetPath, settingsSwitched: switched, restartAction: onlyModelChanged ? 'restartBridge' : 'restart' };
    }
    else if (action === 'env' || action === 'runtime') {
      const guard = typeof data === 'object' && data !== null && typeof data.text === 'string' ? data : null;
      if (guard) data = guard.text;
      if (action === 'runtime') data = mergeRuntimeEnv(await read('.env'), data);
      validateRuntimeEnv(data);
      const targetPath = settingsFileFor(data);
      if (guard?.hasSettingsDrafts && targetPath !== resolve(guard.settingsPath)) throw new Error('配置格式无效：请先保存机器人设置，再切换动态配置文件');
      const nextSettings = await settings.readSettingsFile(targetPath);validateMediaService(nextSettings, data);
      data=await protectEnvironmentText(process.cwd(),data,await read('.env'));
      await atomic(resolve('.env'), data); result = { env: data, runtimeFields: await describeEnv(data), settings:nextSettings, settingsPath:targetPath };
    } else if (action === 'persona') {
      if (typeof data?.text !== 'string' || resolve(data.path) !== personaPath) throw new Error('工作区已变更，请重新打开控制台后编辑人设');
      await atomic(personaPath, data.text); result = true;
    }
    else throw new Error('未知配置操作');
    process.send({ ok: true, result }, () => process.disconnect());
  } catch (e) {
    const error = e.issues ? e.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')
      : e.code === 'BOT_RESOURCE_LOCKED' || e.code?.startsWith('DATABASE_') || /工作区已变更|协议无效|配置格式无效|^Windows 凭据|^管理操作失败：|^空间连接检查失败：/.test(e.message) ? e.message : '配置操作失败，请检查文件格式与访问权限；原有文件保留。';
    process.send({ ok: false, error }, () => process.disconnect());
  } finally {
    configurationLease?.release();
    settingsLease?.release();
    dataLease?.release();
  }
});
