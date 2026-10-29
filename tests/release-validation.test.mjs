import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative,isAbsolute,basename} from 'node:path';
import {validateRelease,releaseRequired} from '../scripts/release-validation.mjs';

async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'qq-release-validation-'));
  const write=async(name,content='')=>{const file=join(root,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,content);};
  try{for(const name of releaseRequired)await write(name);await run({root,write});}
  finally{const actual=await realpath(root),base=await realpath(tmpdir()),rel=relative(base,actual);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(actual).startsWith('qq-release-validation-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}

test('发行校验发现静态/动态导入和 Worker 引用缺失，不执行入口代码',()=>fixture(async({root,write})=>{
  await write('scripts/runtime-service.mjs',"import './runtime-configuration.mjs';const load=()=>import('./qq-runtime.mjs');const worker=new URL('../desktop/config-worker.mjs',import.meta.url);throw new Error('不得执行');");
  const valid=await validateRelease(root);assert.equal(valid.relativeImports,3);assert.ok(valid.modules>10);
  await write('scripts/runtime-service.mjs',"const login=()=>import('./missing-login.mjs');");await assert.rejects(validateRelease(root),/缺少依赖.*missing-login/);
  await write('scripts/runtime-service.mjs',"const worker=new URL('../desktop/missing-worker.mjs',import.meta.url)");await assert.rejects(validateRelease(root),/缺少依赖.*missing-worker/);
}));

test('发行校验发现缺失的生产依赖、语法错误和越界引用',()=>fixture(async({root,write})=>{
  await write('scripts/runtime-service.mjs',"import 'missing-production-dependency';");await assert.rejects(validateRelease(root),/缺少生产依赖/);
  await write('scripts/runtime-service.mjs',"export const broken = ;");await assert.rejects(validateRelease(root),/语法无效/);
  await write('scripts/runtime-service.mjs',"export * from '../../outside.mjs';");await assert.rejects(validateRelease(root),/越过程序目录/);
}));

test('发行校验拒绝遗漏的登录模块、原生保护助手与个人数据',()=>fixture(async({root,write})=>{
  await rm(join(root,'scripts/qq-runtime.mjs'));await assert.rejects(validateRelease(root),/qq-runtime/);await write('scripts/qq-runtime.mjs');
  await rm(join(root,'scripts/qq-profile-preload.mjs'));await assert.rejects(validateRelease(root),/qq-profile-preload/);await write('scripts/qq-profile-preload.mjs');
  await rm(join(root,'desktop/runtime-guard.exe'));await assert.rejects(validateRelease(root),/runtime-guard/);await write('desktop/runtime-guard.exe');
  await write('.env','fixture-private-token');await assert.rejects(validateRelease(root),/个人配置/);await rm(join(root,'.env'));await mkdir(join(root,'user-data'));await assert.rejects(validateRelease(root),/user-data/);
}));

test('发行校验拒绝程序目录联接和文件链接',()=>fixture(async({root,write})=>{
  await mkdir(join(root,'source'));await write('source/hidden.mjs','');await symlink(join(root,'source'),join(root,'scripts/linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(validateRelease(root),/不接受链接/);
}));
