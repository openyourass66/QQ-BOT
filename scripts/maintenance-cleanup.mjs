import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {dataPaths} from '../dist/core/data-paths.js';
import {cleanupMedia} from '../dist/services/media-cleanup.js';
import {mediaCleanerExecutable,mediaRemover} from './media-cleaner.mjs';
import {assertNoPendingRestore} from './app-paths.mjs';

export async function maintainMedia({root,dataRoot,retentionDays=30,dryRun=true,signal,onProgress=()=>{}}){
  assertNoPendingRestore(dataRoot);const env=parseEnv(await readFile(join(dataRoot,'.env'),'utf8')),paths=dataPaths(env,resolve(dataRoot));
  const options={retentionDays,dryRun,signal,limit:1000,budgetMs:300000,onProgress:event=>onProgress({stage:'cleanup',files:event.examined,bytes:0,deleted:event.deleted,protected:event.protected})};
  if(!dryRun){let executable;options.remove=async(...args)=>{executable??=await mediaCleanerExecutable({root,dataRoot,signal});return mediaRemover(executable)(...args);};}
  const result=await cleanupMedia(paths,options);return {operation:dryRun?'cleanup-preview':'cleanup',retentionDays,...result};
}
