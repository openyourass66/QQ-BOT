import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,readdir,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import yauzl from 'yauzl';

async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'qq-release-archive-')),release=join(root,'release'),source=join(release,'中文 空格程序'),target=join(release,'程序.zip');
  try{await mkdir(source,{recursive:true});await mkdir(join(root,'scripts'));await cp(resolve('scripts/zip-release.ps1'),join(root,'scripts/zip-release.ps1'));await run({root,release,source,target});}
  finally{const actual=await realpath(root),base=await realpath(tmpdir()),rel=relative(base,actual);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&basename(actual).startsWith('qq-release-archive-'));await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
}
async function compress({root,source,target}){
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/zip-release.ps1'),'-Source',source,'-Destination',target],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>error=(error+chunk).slice(-5000));const code=(await once(child,'exit'))[0];return {code,error};
}
async function names(path){
  const zip=await new Promise((done,reject)=>yauzl.open(path,{strictFileNames:true,lazyEntries:true},(error,zip)=>error?reject(error):done(zip))),result=[];
  await new Promise((done,reject)=>{zip.on('entry',entry=>{result.push(entry.fileName);zip.readEntry();});zip.on('end',done);zip.on('error',reject);zip.readEntry();});return result;
}
if(process.platform==='win32'){
  test('Windows ZIP 使用标准分隔符保留中文、空格、隐藏模板和空目录，不覆盖既有归档',()=>fixture(async args=>{
    const {source,target,release}=args;await mkdir(join(source,'子目录'));await mkdir(join(source,'空目录'));await writeFile(join(source,'.env.example'),'public-template');await writeFile(join(source,'子目录','使用说明.txt'),'中文说明');
    const built=await compress(args);assert.equal(built.code,0,built.error);assert.deepEqual(new Set(await names(target)),new Set(['中文 空格程序/.env.example','中文 空格程序/子目录/使用说明.txt','中文 空格程序/空目录/']));
    const before=await readFile(target);assert.notEqual((await compress(args)).code,0);assert.deepEqual(await readFile(target),before);assert.ok(!(await readdir(release)).some(name=>name.includes('.tmp-')));
  }));
  test('Windows ZIP 拒绝链接和越界输出，失败时清除本次暂存文件',()=>fixture(async args=>{
    const {root,source,release,target}=args;await mkdir(join(root,'outside'));await writeFile(join(source,'public.txt'),'public');await writeFile(join(root,'outside','private.txt'),'private');await symlink(join(root,'outside'),join(source,'linked'),'junction');
    assert.notEqual((await compress(args)).code,0);await assert.rejects(readFile(target),{code:'ENOENT'});assert.ok(!(await readdir(release)).some(name=>name.includes('.tmp-')));
    assert.notEqual((await compress({...args,target:join(root,'outside.zip')})).code,0);await assert.rejects(readFile(join(root,'outside.zip')),{code:'ENOENT'});assert.equal(await readFile(join(root,'outside','private.txt'),'utf8'),'private');
  }));
}
