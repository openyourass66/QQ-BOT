import {readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs,parseEnv} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {assertApplicationRuntime} from '../dist/core/node-runtime.js';
import {DATABASE_SCHEMA_VERSION} from '../dist/storage/database-types.js';
import {dataPaths} from '../dist/core/data-paths.js';
import {validateRuntimeEnv} from '../desktop/runtime-fields.mjs';
import {validateSettings} from '../dist/core/settings.js';

async function configuration(path){const state=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(!state)return '';if(!state.isFile()||state.isSymbolicLink()||state.nlink!==1||state.size>2*1024*1024)throw Error();return readFile(path,'utf8');}

try{
  assertApplicationRuntime();const {values}=parseArgs({options:{'data-dir':{type:'string'}}});if(!values['data-dir'])throw Error();const root=resolve(values['data-dir']);
  const raw=await configuration(join(root,'.env'));if(raw)validateRuntimeEnv(raw);const env=parseEnv(raw),paths=dataPaths(env,root);
  const settings=await configuration(resolve(root,env.BOT_SETTINGS_FILE||'bot.config.json'));if(settings)validateSettings(JSON.parse(settings));
  for(const key of ['sessions','groupContext','usage','social']){const path=paths[key]+'.sqlite',info=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(!info)continue;if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error();const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=1000;');if(Number(Object.values(db.prepare('PRAGMA user_version').get())[0])>DATABASE_SCHEMA_VERSION||db.prepare('PRAGMA quick_check(1)').all().some(row=>Object.values(row)[0]!=='ok'))throw Error();}finally{db.close();}}
  console.log(JSON.stringify({ok:true,kind:'read-only-install-check'}));
}catch{console.log(JSON.stringify({ok:false,error:'安装后检查未通过，程序尚未开放业务；请保留当前配置和恢复点。'}));process.exitCode=1;}
