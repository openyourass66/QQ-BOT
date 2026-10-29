import { resolve } from 'node:path';
import { enterRuntime, prepareRuntime } from './app-paths.mjs';
import { listComponents, prepareComponent } from './components/manager.mjs';

const abort = new AbortController();
process.on('SIGINT',()=>abort.abort());
try {
  const [action = 'list', ...args] = process.argv.slice(2);
  const id = action === 'install' ? args.shift() : undefined;
  let archivePath;
  const index = args.indexOf('--archive');
  if (index >= 0) { if (!args[index+1]) throw new Error('--archive 需要本地组件包路径'); archivePath=resolve(args[index+1]); args.splice(index,2); }
  const layout = await prepareRuntime({args}); enterRuntime(layout,{loadEnv:false});
  if (action === 'list') console.log(JSON.stringify(await listComponents({dataRoot:layout.dataRoot}),null,2));
  else if (action === 'install') {
    let last = '', at = 0;
    const result = await prepareComponent({id,archivePath,dataRoot:layout.dataRoot,signal:abort.signal,onProgress:event=>{
      const key=event.id+':'+event.phase;
      if(key!==last||Date.now()-at>=1000){console.log(`${key}${event.total?' '+Math.round(event.received/event.total*100)+'%':''}`);last=key;at=Date.now();}
    }});
    console.log(JSON.stringify(result,null,2));
  } else throw new Error('组件命令为 list 或 install 组件名');
} catch (error) { console.error(abort.signal.aborted?'已取消':error.message); process.exitCode=1; }
