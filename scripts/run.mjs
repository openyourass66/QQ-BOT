import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { enterRuntime, prepareRuntime } from './app-paths.mjs';

try {
  const [command = 'bridge', ...args] = process.argv.slice(2);
  const entries = { bridge: 'dist/bridge.js', mcp: 'dist/mcp-qq.js', napcat: 'scripts/napcat-node.mjs', setup: null };
  if (!Object.hasOwn(entries, command)) throw new Error('启动命令必须是 bridge、mcp、napcat 或 setup。');
  const layout = await prepareRuntime({ args });
  enterRuntime(layout);
  if (entries[command]) await import(pathToFileURL(join(layout.programRoot, entries[command])).href);
  else console.log(`配置与人设已准备：${layout.dataRoot}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
