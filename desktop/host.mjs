import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {prepareRuntime,enterRuntime} from '../scripts/app-paths.mjs';
import {createRuntimeService} from '../scripts/runtime-service.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const layout=await prepareRuntime({root,args:process.argv.slice(2)});enterRuntime(layout,{loadEnv:false});
const emit=event=>process.stdout.write(JSON.stringify(event)+'\n');
const service=await createRuntimeService({root,layout,onEvent:emit,onFatal:()=>process.exit(1)});
const input=createInterface({input:process.stdin});let exiting=false;
async function shutdown(){if(exiting)return;exiting=true;try{await service.close();}finally{process.exit();}}
input.on('line',line=>{let request;try{if(Buffer.byteLength(line)>4194304)throw new Error();request=JSON.parse(line);}catch{emit({type:'error',text:'控制命令格式无效或过大'});return;}
service.receive(request).then(()=>{if(service.quitting)shutdown();}).catch(()=>{});});
input.on('close',shutdown);process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
