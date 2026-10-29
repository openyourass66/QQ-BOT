import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWebOwner,OwnerAuth} from '../server/auth.mjs';

async function fixture(run) {const root=await mkdtemp(join(tmpdir(),'qq-web-auth-'));try{return await run(root);}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}}
const password='fixture-long-owner-passphrase';

test('网页主人只能用未过期的一次性码认领，口令及认领原文不落盘，退出撤销会话',()=>fixture(async root=>{
  const initial=await initializeWebOwner(root),auth=new OwnerAuth(root);
  assert.equal((await auth.status()).setupRequired,true);
  await assert.rejects(auth.claim({token:'wrong',password},'fixture'),{statusCode:401});
  await assert.rejects(auth.claim({token:initial.token,password:'short'},'fixture'),{statusCode:400});
  const session=await auth.claim({token:initial.token,password},'fixture');
  const file=await readFile(join(root,'data/management/auth.json'),'utf8');assert.ok(!file.includes(password)&&!file.includes(initial.token));assert.equal((await auth.status()).setupRequired,false);
  assert.equal((await auth.verify(session.token)).csrf,session.csrf);
  await assert.rejects(auth.claim({token:initial.token,password},'other'),{statusCode:401});
  auth.logout(session.token);await assert.rejects(auth.verify(session.token),{statusCode:401});
  const loggedIn=await auth.login({password},'other');assert.ok((await auth.verify(loggedIn.token)).id);
}));

test('网页会话有空闲与最长有效期，CSRF 非 ASCII 输入也明确拒绝，本机重置使旧会话失效',()=>fixture(async root=>{
  let now=Date.now();const initial=await initializeWebOwner(root,{now}),auth=new OwnerAuth(root,{clock:()=>now});
  const first=await auth.claim({token:initial.token,password},'fixture');
  await assert.rejects(auth.csrf(first.token,'中'.repeat(43)),{statusCode:403});
  await assert.rejects(auth.csrf(first.token,'x'.repeat(43)),{statusCode:403});
  await auth.csrf(first.token,first.csrf);now+=30*60000+1;await assert.rejects(auth.verify(first.token),{statusCode:401});
  const second=await auth.login({password},'fixture');for(let i=0;i<24;i++){now+=29*60000;await auth.verify(second.token);}
  now=second.expires+1;await assert.rejects(auth.verify(second.token),{statusCode:401});
  const third=await auth.login({password},'fixture');await initializeWebOwner(root,{reset:true,now});await assert.rejects(auth.verify(third.token),{statusCode:401});
}));

test('认领码过期明确失败，登录限速，凭据初始化不覆盖已有主人',()=>fixture(async root=>{
  let now=Date.now();const initial=await initializeWebOwner(root,{now}),auth=new OwnerAuth(root,{clock:()=>now});
  await assert.rejects(initializeWebOwner(root),/已存在/);
  now+=15*60000+1;assert.equal((await auth.status()).claimExpired,true);
  for(let i=0;i<5;i++)await assert.rejects(auth.claim({token:initial.token,password},'fixture'),{statusCode:401});
  await assert.rejects(auth.claim({token:initial.token,password},'fixture'),{statusCode:429});
}));
