import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,realpath,symlink} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {copyPublicInputs,copyCompiledInputs} from '../scripts/release-inputs.mjs';

async function fixture(run){const parent=await realpath(tmpdir()),base=await mkdtemp(join(parent,'qq-release-inputs-')),root=join(base,'source'),target=join(base,'output');const write=async(name,text)=>{const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,text);};try{await mkdir(target);await run({root,target,write,base});}finally{const actual=await realpath(base);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('qq-release-inputs-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:100});}}
test('发行只复制明确的已提交公开文件，排除忽略的组件安装与私人调试文件',()=>fixture(async({root,target,write})=>{
  for(const [path,value] of [['components/catalog.json','public'],['components/active.json','private-component'],['components/dsh/runtime/login.json','private-login'],['desktop/host.mjs','export {};'],['desktop/private-debug.mjs','private-token'],['templates/bot-persona.md','public-persona'],['templates/.env','private-token']])await write(path,value);
  await copyPublicInputs(root,target,['components/catalog.json','desktop/host.mjs','templates/bot-persona.md']);assert.equal(await readFile(join(target,'components/catalog.json'),'utf8'),'public');for(const path of ['components/active.json','components/dsh/runtime/login.json','desktop/private-debug.mjs','templates/.env'])await assert.rejects(lstat(join(target,path)),{code:'ENOENT'});
}));
test('编译输出只复制有源码的 JavaScript 与映射，不打包数据或孤立旧输出',()=>fixture(async({root,target,write})=>{
  await write('src/core/value.ts','export const value=1;');await write('dist/core/value.js','export const value=1;');await write('dist/core/value.js.map','{}');await write('dist/private.json','private');await write('dist/stale.js','private');await copyCompiledInputs(root,target);assert.equal(await readFile(join(target,'dist/core/value.js'),'utf8'),'export const value=1;');for(const path of ['dist/private.json','dist/stale.js'])await assert.rejects(lstat(join(target,path)),{code:'ENOENT'});
}));
test('发行输入拒绝链接及越界路径，不复制外部文件',()=>fixture(async({root,target,write,base})=>{
  await write('components/catalog.json','public');await assert.rejects(copyPublicInputs(root,target,['../outside']),/路径/);await mkdir(join(base,'outside'));await symlink(join(base,'outside'),join(root,'components/link'),process.platform==='win32'?'junction':'dir');await writeFile(join(base,'outside/private.json'),'keep');await assert.rejects(copyPublicInputs(root,target,['components/link/private.json']),/链接/);assert.equal(await readFile(join(base,'outside/private.json'),'utf8'),'keep');
}));
