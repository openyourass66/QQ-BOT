import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
try { loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const settings = await import('../dist/settings.js');
const read = async (p) => readFile(p, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
const personaPath = resolve(process.env.BOT_WORKSPACE || 'bot-workspace', 'AGENTS.md');
const atomic = async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p + '.desktop.tmp', text, 'utf8'); await rename(p + '.desktop.tmp', p); };
process.once('message', async ({ action, data }) => {
  try {
    let result;
    if (action === 'load') result = { settings: await settings.loadSettings(), env: await read('.env') || await read('.env.example'), persona: await read(personaPath), personaPath };
    else if (action === 'settings') result = await settings.saveSettings(data);
    else if (action === 'env') {
      // Node's own parser validates syntax before replacing the active file.
      if (typeof data !== 'string' || data.includes('\0')) throw new Error('连接配置格式无效');
      const { parseEnv } = await import('node:util');
      const parsed = parseEnv(data);
      for (const key of ['ONEBOT_HTTP_URL', 'ONEBOT_WS_URL']) if (parsed[key]) {
        const url = new URL(parsed[key]);
        if (!(key === 'ONEBOT_HTTP_URL' ? ['http:', 'https:'] : ['ws:', 'wss:']).includes(url.protocol)) throw new Error(key + ' 协议无效');
      }
      await atomic(resolve('.env'), data); result = true;
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
