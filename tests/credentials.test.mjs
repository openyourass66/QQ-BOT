import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {protectEnvironmentText,resolveCredentialEnv} from '../scripts/credentials.mjs';
import {fork} from 'node:child_process';
import {environment} from '../desktop/diagnostics.mjs';
import {RuntimeConfiguration} from '../scripts/runtime-configuration.mjs';
import {mergeRuntimeEnv} from '../desktop/runtime-fields.mjs';

test('源码兼容输入保持明文原文，错误和越界凭据引用不泄露内容',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-vault-'));const mode=process.env.BOT_CREDENTIAL_MODE;delete process.env.BOT_CREDENTIAL_MODE;
  try{
    const text='ONEBOT_TOKEN=fixture-source-token\n# personal comment\n';assert.equal(await protectEnvironmentText(root,text),text);
    for(const value of ['@whale-credential:../elsewhere','@whale-credential:'+'a'.repeat(32)])await assert.rejects(resolveCredentialEnv(root,{ONEBOT_TOKEN:value}),error=>/Windows 凭据/.test(error.message)&&!error.message.includes(value));
  }finally{mode===undefined?delete process.env.BOT_CREDENTIAL_MODE:process.env.BOT_CREDENTIAL_MODE=mode;await rm(root,{recursive:true,force:true});}
});

test('桌面与共用配置入口保存引用，启动读取实际凭据，损坏引用仍能显示编辑器并重新输入',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-vault-worker-'));
  const worker=(action,data)=>new Promise((done,reject)=>{
    const child=fork(resolve('desktop/config-worker.mjs'),[],{cwd:root,silent:true,execArgv:[],env:{...process.env,BOT_CREDENTIAL_MODE:'dpapi',BOT_SETTINGS_FILE:join(root,'settings.json'),BOT_WORKSPACE:root}});
    let reply;child.once('message',result=>{reply=result;});child.once('exit',()=>reply?done(reply):reject(new Error('配置进程无回复')));child.once('error',reject);child.send({action,data});
  });
  try {
    await writeFile(join(root,'.env'),'BOT_CHAT_MODE=profile\nBOT_WORKSPACE=.\n');
    let result=await worker('runtime',{ONEBOT_TOKEN:'fixture-protected-token'});assert.equal(result.ok,true,JSON.stringify(result));assert.doesNotMatch(result.result.env,/fixture-protected-token/);
    assert.equal(result.result.runtimeFields.find(field=>field.key==='ONEBOT_TOKEN').value,'fixture-protected-token');
    assert.equal((await environment(root)).ONEBOT_TOKEN,'fixture-protected-token');
    const configuration=new RuntimeConfiguration(root,{protectedCredentials:true}),before=await configuration.read();
    await configuration.update({revision:before.revision,secret:{name:'ONEBOT_TOKEN',operation:'replace',value:'fixture-next-token'}});
    assert.equal((await environment(root)).ONEBOT_TOKEN,'fixture-next-token');
    const text=await readFile(join(root,'.env'),'utf8');assert.doesNotMatch(text,/fixture-next-token/);
    const id=/@whale-credential:([a-f0-9]{32})/.exec(text)[1];await writeFile(join(root,'.credentials',id+'.json'),'{}');
    await assert.rejects(environment(root),/Windows 凭据/);
    result=await worker('load');assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.runtimeFields.find(field=>field.key==='ONEBOT_TOKEN').credentialUnavailable,true);
    result=await worker('runtime',{ONEBOT_TOKEN:'fixture-recovered-token'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal((await environment(root)).ONEBOT_TOKEN,'fixture-recovered-token');
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('Windows 当前用户 DPAPI 保护多项凭据，保留未知字段和加密恢复材料，未修改密钥复用原引用',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-vault-dpapi-')),mode=process.env.BOT_CREDENTIAL_MODE;process.env.BOT_CREDENTIAL_MODE='dpapi';
  try{
    const original='ONEBOT_TOKEN=fixture-private-token\nQQ_BOT_DEEPSEEK_API_KEY=fixture-model-key\nPRIVATE_SETTING=keep\n# personal comment\n';
    const protectedText=await protectEnvironmentText(root,original,original);
    assert.doesNotMatch(protectedText,/fixture-private-token|fixture-model-key/);assert.match(protectedText,/PRIVATE_SETTING=keep/);assert.match(protectedText,/# personal comment/);
    const restored=await resolveCredentialEnv(root,parseEnv(protectedText));assert.equal(restored.ONEBOT_TOKEN,'fixture-private-token');assert.equal(restored.QQ_BOT_DEEPSEEK_API_KEY,'fixture-model-key');
    const files=await readdir(join(root,'.credentials'));assert.equal(files.length,3);assert.ok(files.some(file=>file.startsWith('legacy-env-')));
    for(const file of files)assert.doesNotMatch(await readFile(join(root,'.credentials',file),'utf8'),/fixture-private-token|fixture-model-key/);
    const next=await protectEnvironmentText(root,original,protectedText);assert.equal(next,protectedText);assert.equal((await readdir(join(root,'.credentials'))).length,3);
    const multiline='BOT_MEDIA_API_KEY="fixture-multiline\nsecond-private-line"\n# preserved\n';
    const sealed=await protectEnvironmentText(root,multiline);assert.doesNotMatch(sealed,/fixture-multiline|second-private-line/);assert.match(sealed,/# preserved/);
    assert.equal((await resolveCredentialEnv(root,parseEnv(sealed))).BOT_MEDIA_API_KEY,'fixture-multiline\nsecond-private-line');
    const replaced=await protectEnvironmentText(root,mergeRuntimeEnv(multiline,{BOT_MEDIA_API_KEY:'replacement-value'}),multiline);
    assert.doesNotMatch(replaced,/fixture-multiline|second-private-line|replacement-value/);assert.equal((await resolveCredentialEnv(root,parseEnv(replaced))).BOT_MEDIA_API_KEY,'replacement-value');
    const bom=await protectEnvironmentText(root,'\ufeffONEBOT_TOKEN=fixture-bom-token\n');assert.doesNotMatch(bom,/fixture-bom-token/);assert.equal((await resolveCredentialEnv(root,parseEnv(bom))).ONEBOT_TOKEN,'fixture-bom-token');
    const entry=files.find(file=>!file.startsWith('legacy-env-'));await writeFile(join(root,'.credentials',entry),'{}');
    await assert.rejects(resolveCredentialEnv(root,parseEnv(protectedText)),/Windows 凭据/);
  }finally{mode===undefined?delete process.env.BOT_CREDENTIAL_MODE:process.env.BOT_CREDENTIAL_MODE=mode;await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
