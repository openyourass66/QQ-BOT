import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {verifyReleasePackage,releaseFileName} from '../scripts/release-integrity.mjs';
import {releaseFixture} from './helpers/releases.mjs';

test('发行签名绑定来源、通道和所有文件，验证后不执行新包代码',()=>releaseFixture(async({make,trustFile})=>{
  const packageRoot=await make('中文 发行'),result=await verifyReleasePackage({packageRoot,trustFile});assert.equal(result.keyId,'fixture-test');assert.equal(result.manifest.version,'0.2.0');assert.ok(result.manifest.files.some(file=>file.path===(process.platform==='win32'?'runtime/node.exe':'runtime/bin/node')));
  await writeFile(join(packageRoot,'scripts/install-worker.mjs'),'tampered-content');await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/摘要不匹配/);
}));
test('缺失签名、未知发布者、通道越界及篡改清单均拒绝',()=>releaseFixture(async({make,trustFile})=>{
  const packageRoot=await make('app'),signature=await readFile(join(packageRoot,'release-integrity.sig.json'));await rm(join(packageRoot,'release-integrity.sig.json'));await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/缺失|损坏/);await writeFile(join(packageRoot,'release-integrity.sig.json'),signature);
  const raw=await readFile(trustFile,'utf8'),trust=JSON.parse(raw);trust.keys[0].id='unknown';await writeFile(trustFile,JSON.stringify(trust));await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/发布者/);trust.keys[0].id='fixture-test';trust.keys[0].channels=['stable'];await writeFile(trustFile,JSON.stringify(trust));await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/发布者/);await writeFile(trustFile,raw);
  const path=join(packageRoot,'release-integrity.json'),manifest=JSON.parse(await readFile(path,'utf8'));manifest.sourceRevision='2'.repeat(40);await writeFile(path,JSON.stringify(manifest));await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/发布者/);
}));
test('发行验证拒绝额外文件、链接和不安全名称',()=>releaseFixture(async({make,trustFile,fixture})=>{
  for(const value of ['../escape','a/../../b','c:/a','a\\b','a/CON.txt','a/file.','a//b'])assert.equal(releaseFileName(value),false,value);
  const packageRoot=await make('app');await writeFile(join(packageRoot,'extra.txt'),'extra');await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/未登记/);await rm(join(packageRoot,'extra.txt'));await mkdir(join(fixture,'outside'));await symlink(join(fixture,'outside'),join(packageRoot,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(verifyReleasePackage({packageRoot,trustFile}),/链接/);
}));
