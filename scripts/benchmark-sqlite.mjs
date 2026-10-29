import {mkdtemp,writeFile,rm,stat,mkdir,readFile,readdir} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {SqliteSocialStore} from '../dist/storage/sqlite-social-store.js';
import {SocialDataSchema} from '../dist/qq/social-store.js';
import {createHash} from 'node:crypto';

const {values}=parseArgs({options:{sizes:{type:'string',default:'10000,50000'},samples:{type:'string',default:'100'},rounds:{type:'string',default:'3'},output:{type:'string'}}});
const sizes=values.sizes.split(',').map(Number),samples=Number(values.samples),rounds=Number(values.rounds);
if(sizes.some(n=>!Number.isSafeInteger(n)||n<1||n>100000)||!Number.isSafeInteger(samples)||samples<10||samples>10000||!Number.isSafeInteger(rounds)||rounds<1||rounds>5)throw new Error('基准参数无效');
const percentile=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>Math.round(sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]*1000)/1000;return {p50:at(.5),p95:at(.95),p99:at(.99),max:at(1)};};
const sourceHash=createHash('sha256');for(const file of (await readdir(new URL('../src/storage/',import.meta.url))).filter(file=>file.endsWith('.ts')).sort())sourceHash.update(file+'\n').update(await readFile(new URL('../src/storage/'+file,import.meta.url)));
const storageSourceSha256=sourceHash.digest('hex');
const root=await mkdtemp(join(tmpdir(),'qq-sqlite-benchmark-')),results=[];const text='用于隔离性能评估的模拟聊天内容。'.repeat(12);let activeStore;
async function seed(path,count){const now=Date.now(),data=SocialDataSchema.parse({version:2,messages:[],contacts:[],memories:[],stickers:[],tasks:[],events:[],actions:[],turns:[]});data.messages=Array.from({length:count},(_,i)=>({chat:`group:${10000+i%20}`,id:i+1,user:100000+i%20,name:'模拟用户',at:now-count*1000+i*1000,text,segments:[{type:'text',data:{text}}],self:false,recalled:false}));await writeFile(path,JSON.stringify(data));}
try{
  for(const count of sizes)for(let round=1;round<=rounds;round++){
    const path=join(root,`social-${count}-${round}.json`);await seed(path,count);global.gc?.();
    const store=activeStore=new SqliteSocialStore(path),start=performance.now();await store.load();const migrationMs=performance.now()-start;global.gc?.();
    let next=count;const record=()=>store.record({post_type:'message',message_type:'group',self_id:42,user_id:43,group_id:10000+next%20,message_id:++next,time:Math.floor(Date.now()/1000),raw_message:text,message:[{type:'text',data:{text}}],sender:{user_id:43,nickname:'模拟用户'}},30,2000);
    const first=performance.now();await record();const firstRecordMs=performance.now()-first;for(let warm=0;warm<25;warm++)await record();
    const workerMs=[],archiveMs=[],queries=[];store.onMeasurement=(action,elapsed)=>{if(action==='add-message')workerMs.push(elapsed);};
    const delay=monitorEventLoopDelay({resolution:10});delay.enable();await new Promise(done=>setTimeout(done,20));
    for(let i=0;i<samples;i++){const start=performance.now();await record();archiveMs.push(performance.now()-start);}
    for(let i=0;i<20;i++){const start=performance.now();await store.messages('group:10000',100);queries.push(performance.now()-start);}
    await new Promise(done=>setTimeout(done,20));delay.disable();global.gc?.();
    const retained=(await store.queryMessages({limit:1})).total,files={};for(const suffix of ['','-wal','-shm'])files[suffix||'main']=(await stat(path+'.sqlite'+suffix).catch(()=>({size:0}))).size;
    const result={requestedMessages:count,retainedMessages:retained,round,samples,migrationMs,firstRecordMs,archiveMs:percentile(archiveMs),workerMs:percentile(workerMs),queryMs:percentile(queries),eventLoopP99Ms:delay.percentile(99)/1e6,eventLoopMaxMs:delay.max/1e6,rssMiB:process.memoryUsage().rss/1024/1024,files};results.push(result);console.error(`${count} 条 第 ${round} 轮：归档 P95 ${result.archiveMs.p95}ms，Worker P95 ${result.workerMs.p95}ms`);await store.close();
  }
}finally{await activeStore?.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
const report={measuredAt:new Date().toISOString(),storageSourceSha256,diagnosticOnly:true,note:'固定 20 会话的短串行诊断，不替代 30 分钟并发负载或连续运行验收；初始迁移和首次保留期清理另列。归档上限为 50000 条。RSS 包含 Worker，生成夹具后已请求 GC。',node:process.version,platform:process.platform,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryGiB:totalmem()/1024**3,results};
const json=JSON.stringify(report,null,2)+'\n';if(values.output){await mkdir(dirname(resolve(values.output)),{recursive:true});await writeFile(resolve(values.output),json);}console.log(json);
