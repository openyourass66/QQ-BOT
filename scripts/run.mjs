import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import { enterRuntime, prepareRuntime } from './app-paths.mjs';
import {resolveCredentialEnv} from './credentials.mjs';
import {ProcessGuard} from './process-guard.mjs';

try {
  const [command = 'bridge', ...args] = process.argv.slice(2);
  const entries = { bridge: 'dist/bridge.js', mcp: 'dist/mcp-qq.js', napcat: 'scripts/napcat-node.mjs', setup: null };
  if (!Object.hasOwn(entries, command)) throw new Error('启动命令必须是 bridge、mcp、napcat 或 setup。');
  const layout = await prepareRuntime({ args });
  enterRuntime(layout);
  Object.assign(process.env,await resolveCredentialEnv(layout.dataRoot,parseEnv((await readFile(layout.envFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})).replace(/^\uFEFF/,''))));
  if(command==='bridge'||command==='napcat'){
    const guard=new ProcessGuard({root:layout.programRoot,dataRoot:layout.dataRoot});
    try{
      const env={...process.env};if(command==='napcat')for(const key of ['QQ_BOT_DEEPSEEK_API_KEY','BOT_MEDIA_API_KEY','BOT_LEARNING_API_KEY'])delete env[key];
      const child=await guard.fork(entries[command],{cwd:layout.dataRoot,env});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
      let timer;
      const stop=()=>{if(timer)return;if(command==='bridge'&&child.connected)child.send('shutdown',()=>{});else void guard.terminate(child);timer=setTimeout(()=>void guard.terminate(child),7000);};
      process.on('SIGINT',stop);process.on('SIGTERM',stop);guard.onLost=()=>{process.exitCode=1;};
      const code=await new Promise(done=>child.once('close',code=>done(code)));
      clearTimeout(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);process.exitCode=code??1;
    }finally{await guard.close();}
  }
  else if (entries[command]) await import(pathToFileURL(join(layout.programRoot, entries[command])).href);
  else console.log(`配置与人设已准备：${layout.dataRoot}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
