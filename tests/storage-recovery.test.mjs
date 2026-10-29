import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SocialStore } from '../dist/qq/social-store.js';

test('Windows 暂时占用存档文件超过旧重试窗口时，保存仍能恢复', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-storage-recovery-'));
  let child;
  try {
    const file=join(root,'social.json'),store=new SocialStore(file);await store.load();await store.update(()=>{});
    const script="$f=[IO.File]::Open($env:QQBOT_TEST_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);[Console]::WriteLine('locked');[Console]::In.ReadLine()|Out-Null;$f.Dispose()";
    child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QQBOT_TEST_LOCK:file},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const exited=once(child,'exit');
    await once(child.stdout,'data');const timer=setTimeout(()=>child.stdin.end('\n'),500);
    try{await store.update(d=>{d.account=10000;});}finally{clearTimeout(timer);child.stdin.end('\n');}
    await exited;assert.equal(JSON.parse(await readFile(file,'utf8')).account,10000);
  } finally {
    if(child?.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(root,{recursive:true,force:true});
  }
});
