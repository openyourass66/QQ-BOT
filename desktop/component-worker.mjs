import { listComponents, prepareComponent } from '../scripts/components/manager.mjs';
import { programRoot } from '../scripts/component-paths.mjs';

const abort = new AbortController();
let running = false;
process.on('message', async message => {
  if (message?.action === 'cancel') { abort.abort(); return; }
  if (running) return;
  running = true;
  try {
    const data = message?.data || {};
    if (Object.keys(data).some(key => !['id','archivePath'].includes(key))) throw new Error('组件操作参数无效');
    let last = 0;
    const progress = event => { const now = Date.now(); if (event.phase !== 'downloading' || now-last >= 200 || event.received === event.total) { last=now; process.send?.({type:'progress',...event}); } };
    const options = { root:programRoot, dataRoot:process.cwd(), signal:abort.signal, onProgress:progress };
    let result;
    if (message.action === 'list') result = {rows:await listComponents(options)};
    else if (message.action === 'install' && ['dsh','napcat'].includes(data.id) && (!data.archivePath || data.id === 'napcat' && typeof data.archivePath === 'string')) result = await prepareComponent({...options,...data});
    else throw new Error('未知组件操作');
    process.send?.({type:'result',ok:true,result},()=>process.disconnect());
  } catch (error) {
    process.send?.({type:'result',ok:false,cancelled:abort.signal.aborted,error:abort.signal.aborted?'已取消，已有组件保持可用。':error.code==='BOT_RESOURCE_LOCKED'?error.message:`组件准备失败：${error.message}。可重试，或从官方来源下载后导入。`},()=>process.disconnect());
  }
});
process.on('disconnect',()=>abort.abort());
