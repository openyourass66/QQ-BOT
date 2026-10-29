import {readFile,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,parseEnv} from 'node:util';
import {runtimeLayout} from './app-paths.mjs';
import {dataPaths,mutableDataResources} from '../dist/core/data-paths.js';
import {acquireDataResources} from '../dist/core/resource-lock.js';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {DatabaseClient} from '../dist/storage/database-client.js';
import {socialDatabasePath,verifyMigrationSource} from '../dist/storage/social-migration.js';
import {cleanupMedia} from '../dist/services/media-cleanup.js';
import {mediaCleanerExecutable,mediaRemover} from './media-cleaner.mjs';

let lease,client;
const cancellation=new AbortController(),cancel=()=>cancellation.abort(new Error('媒体清理已取消，已提交的删除保留，其余文件未继续处理'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},output:{type:'string'},'retention-days':{type:'string'},limit:{type:'string'},'budget-ms':{type:'string'},'dry-run':{type:'boolean'}}});
  const [action='status']=positionals;if(positionals.length>1||!['status','migrate','verify','export','cleanup-media'].includes(action))throw new Error('操作必须为 status、migrate、verify、export 或 cleanup-media。');
  if((action==='export')!==Boolean(values.output))throw new Error('只有 export 操作需要 --output 指定新的导出文件。');
  if(action!=='cleanup-media'&&['retention-days','limit','budget-ms','dry-run'].some(key=>values[key]!==undefined))throw new Error('媒体清理参数只适用于 cleanup-media 操作');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),layout=await runtimeLayout({root,args:values['data-dir']?['--data-dir',values['data-dir']]:[]});
  const raw=await readFile(layout.envFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}),env={...process.env,...parseEnv(raw.replace(/^\uFEFF/,''))};
  const paths=dataPaths(env,layout.dataRoot),path=socialDatabasePath(paths.social);
  if(action==='cleanup-media'){
    const options={dryRun:!!values['dry-run'],signal:cancellation.signal};
    for(const [key,field] of [['retention-days','retentionDays'],['limit','limit'],['budget-ms','budgetMs']])if(values[key]!==undefined){if(!/^\d+$/.test(values[key]))throw new Error('媒体清理参数必须是正整数');options[field]=Number(values[key]);}
    if(!options.dryRun){let executable;options.remove=async(...args)=>{executable??=await mediaCleanerExecutable({root,dataRoot:layout.dataRoot,signal:cancellation.signal});return mediaRemover(executable)(...args);};}
    const result=await cleanupMedia(paths,options);console.log(JSON.stringify({action,...result}));
  }else{
  lease=await acquireDataResources(mutableDataResources(paths));
  const exists=await stat(path).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;});let result;
  if(action==='status'&&!exists){const legacy=await stat(paths.social).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});result={databaseReady:false,legacyFileExists:!!legacy,legacyBytes:legacy?.size??0};}
  else if(action==='migrate'){
    const store=new SqliteSocialStore(paths.social,{onMigrationProgress:progress=>process.stderr.write(`历史记录准备：${progress.stage} ${progress.completed}/${progress.total}\n`)});
    try{await store.load();result={databaseReady:true};}finally{await store.close();}
  }else{
    if(!exists)throw new Error('尚未迁移社交数据，请先运行 migrate；原文件不会被删除。');client=new DatabaseClient(path);
    if(action==='export')result=await client.call({action:'export-social',path:resolve(values.output)});
    else{const metadata=await client.call({action:'metadata'});await verifyMigrationSource(paths.social,metadata.source);result={databaseReady:metadata.initialized,revision:metadata.revision,...await client.call({action:'integrity'})};}
  }
  console.log(JSON.stringify({action,...result}));
  }
}catch(error){console.error(error.message);process.exitCode=1;}
finally{try{await client?.close();}finally{lease?.release();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}}
