import {readFile,lstat,mkdir,writeFile,link,unlink,open,rm} from 'node:fs/promises';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {DATABASE_SCHEMA_VERSION} from '../dist/storage/database-types.js';
import {canonicalRuntimePath,maintenancePending} from './app-paths.mjs';

const info=path=>lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
const boundedVersion=value=>typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?$/.test(value)?value:'unknown';
const mode=(value,allowed,fallback)=>allowed.includes(value)?value:fallback;
const inside=(root,path)=>{const rel=relative(root,path);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};
async function limited(path,max){const item=await info(path);if(!item)return undefined;if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1||item.size>max)throw new Error('诊断输入类型或大小不受支持。');return readFile(path,'utf8');}
async function fileStatus(path){try{const item=await info(path);return !item?{status:'missing'}:item.isSymbolicLink()||!item.isFile()||item.nlink!==1?{status:'unsupported'}:{status:'present',bytes:item.size};}catch{return {status:'unavailable'};}}
async function databaseStatus(path,signal){
  signal?.throwIfAborted();const state=await fileStatus(path);if(state.status!=='present')return state;if(state.bytes>2*1024**3)return {...state,integrity:'not-checked-size-limit'};
  let db;try{db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');const schema=Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);const ok=db.prepare('PRAGMA quick_check(1)').all().every(row=>Object.values(row)[0]==='ok');return {...state,schema,integrity:schema>DATABASE_SCHEMA_VERSION?'newer':ok?'ok':'corrupt'};}catch{return {...state,integrity:'unavailable'};}finally{db?.close();}
}

/** Export by inclusion: never copy configuration, logs, database rows or exception strings. */
export async function exportDiagnostics({root,dataRoot,file,signal,onProgress=()=>{}}){
  signal?.throwIfAborted();dataRoot=await canonicalRuntimePath(resolve(dataRoot));file=resolve(file);
  for(let path=file;;path=dirname(path)){if((await info(path))?.isSymbolicLink())throw new Error('诊断输出不能使用链接路径。');if(dirname(path)===path)break;}
  file=await canonicalRuntimePath(file);const compare=path=>process.platform==='win32'?path.toLowerCase():path;
  if(inside(compare(dataRoot),compare(file)))throw new Error('请将可分享诊断保存到实例数据目录之外。');
  if(await info(file))throw new Error('诊断目标已存在，请选择新的文件名。');
  let env={},configuration='missing';try{const raw=await limited(join(dataRoot,'.env'),2*1024*1024);if(raw!==undefined){env=parseEnv(raw);configuration='readable';}}catch{configuration='unavailable';}
  const paths=dataPaths(env,dataRoot),lease=await acquireDataResources(mutableDataResources(paths,true),signal),temporary=file+'.partial-'+randomUUID();
  try{
    let packageVersion='unknown',sourceRevision='unknown';try{packageVersion=boundedVersion(JSON.parse(await limited(join(root,'package.json'),65536)).version);}catch{}
    try{const value=JSON.parse(await limited(join(root,'release-manifest.json'),65536)).sourceRevision;if(/^[a-f0-9]{40,64}$/.test(value))sourceRevision=value;}catch{}
    const record={formatVersion:1,kind:'whale-redacted-diagnostic',createdAt:new Date().toISOString(),application:{version:packageVersion,sourceRevision},runtime:{platform:process.platform,arch:process.arch,node:boundedVersion(process.versions.node)},configuration:{status:configuration,onebotMode:mode(env.BOT_ONEBOT_MODE,['auto','managed','external'],'auto'),chatMode:mode(env.BOT_CHAT_MODE,['profile','project','account'],'profile'),credentials:Object.fromEntries(['ONEBOT_TOKEN','QQ_BOT_DEEPSEEK_API_KEY','BOT_MEDIA_API_KEY','BOT_LEARNING_API_KEY'].map(key=>[key,Boolean(env[key])]))},recoveryPending:maintenancePending(dataRoot),databases:{},settings:await fileStatus(resolve(dataRoot,env.BOT_SETTINGS_FILE||'bot.config.json')),excluded:['chat-content','prompts','raw-logs','paths','account-identifiers','credential-values','qq-login-state']};
    for(const key of ['sessions','groupContext','usage','social']){signal?.throwIfAborted();record.databases[key]=await databaseStatus(paths[key]+'.sqlite',signal);onProgress({stage:'diagnostic',files:Object.keys(record.databases).length,bytes:0});}
    signal?.throwIfAborted();await mkdir(dirname(file),{recursive:true});await writeFile(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}signal?.throwIfAborted();await link(temporary,file);await unlink(temporary);
    return {operation:'diagnostic',file};
  }finally{try{await rm(temporary,{force:true});}finally{lease.release();}}
}
