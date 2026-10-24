import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseEnv } from 'node:util';
import { runtimeFields } from './runtime-fields.mjs';
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
    else if (action === 'env' || action === 'runtime') {
      if (action === 'runtime') {
        const allowed = new Set(runtimeFields.map(field => field[1]));
        let text = await read('.env');
        for (const [key, value] of Object.entries(data)) {
          if (!allowed.has(key) || typeof value !== 'string' || /[\r\n\0"]/u.test(value)) throw new Error('连接配置格式无效：输入不可包含换行或双引号');
          // Single quotes preserve Windows paths containing literal \n or \r.
          const quote = value.includes("'") ? '"' : "'";
          const line = `${key}=${quote}${value}${quote}`;
          if (parseEnv(line)[key] !== value) throw new Error('连接配置格式无效：无法原样保存该字段的引号或转义字符');
          const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
          if (!value && ['BOT_USAGE_STORE', 'BOT_GROUP_CONTEXT_STORE', 'BOT_DSH_HOME'].includes(key)) { text = text.replace(pattern, ''); continue; }
          if (pattern.test(text)) text = text.replace(pattern, () => line);
          else text += `\n${line}`;
        }
        data = text;
      }
      // Node's own parser validates syntax before replacing the active file.
      if (typeof data !== 'string' || data.includes('\0')) throw new Error('连接配置格式无效');
      const parsed = parseEnv(data);
      for (const key of ['ONEBOT_HTTP_URL', 'ONEBOT_WS_URL']) if (parsed[key]) {
        const url = new URL(parsed[key]);
        if (!(key === 'ONEBOT_HTTP_URL' ? ['http:', 'https:'] : ['ws:', 'wss:']).includes(url.protocol)) throw new Error(key + ' 协议无效');
      }
      if (parsed.BOT_DSH_PROFILE && !/^[\w-]+$/.test(parsed.BOT_DSH_PROFILE)) throw new Error('连接配置格式无效：Profile 只允许字母、数字、下划线和短横线');
      for (const [key, min, max] of [['TURN_TIMEOUT_MS',1000,600000],['QUEUE_PER_CONVERSATION',1,100],['QUEUE_TOTAL',1,1000],['MAX_CONCURRENT_TURNS',1,32]]) {
        if (parsed[key] && (!/^\d+$/.test(parsed[key]) || Number(parsed[key]) < min || Number(parsed[key]) > max)) throw new Error(`连接配置格式无效：${key} 范围 ${min}–${max}`);
      }
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
