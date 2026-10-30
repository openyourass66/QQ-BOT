import {spawnSync} from 'node:child_process';
import {lstat,mkdir,cp,readdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';

const selected=path=>/^(?:templates\/|components\/|desktop\/assets\/|scripts\/components\/)/.test(path)||/^desktop\/[^/]+\.(?:mjs|xaml)$/.test(path)||['.env.example','LICENSE'].includes(path);
const safe=name=>typeof name==='string'&&name&&!/[\\:\x00-\x1f]/.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
export function trackedPublicInputs(root){const result=spawnSync('git',['ls-tree','-r','--name-only','-z','HEAD','--','templates','components','desktop','scripts/components','.env.example','LICENSE'],{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('无法读取已提交的公开发行输入');return result.stdout.split('\0').filter(path=>path&&selected(path));}
export async function copyPublicInputs(root,destination,files){
  root=resolve(root);destination=resolve(destination);
  for(const name of files){if(!safe(name)||!selected(name))throw Error('公开发行输入路径无效');const source=resolve(root,name),target=resolve(destination,name);for(const [base,path] of [[root,source],[destination,target]]){const rel=relative(base,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('公开发行输入路径越界');}
    for(let path=source;path!==root;path=dirname(path))if((await lstat(path)).isSymbolicLink())throw Error('发行输入不接受链接');const state=await lstat(source);if(!state.isFile()||state.nlink!==1)throw Error('公开发行输入必须是独立普通文件');await mkdir(dirname(target),{recursive:true});await cp(source,target,{force:false,errorOnExist:true});
  }
}
export async function copyCompiledInputs(root,destination){
  const sourceRoot=join(root,'dist'),targetRoot=join(destination,'dist');
  const walk=async directory=>{for(const name of await readdir(directory)){const source=join(directory,name),state=await lstat(source);if(state.isSymbolicLink())throw Error('编译输出不能包含链接');if(state.isDirectory()){await walk(source);continue;}if(!/\.js(?:\.map)?$/.test(name))continue;const rel=relative(sourceRoot,source),original=join(root,'src',rel.replace(/\.js(?:\.map)?$/,'.ts'));const input=await lstat(original).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(!input?.isFile())continue;if(!state.isFile()||state.nlink!==1)throw Error('编译输出必须是独立普通文件');const target=join(targetRoot,rel);await mkdir(dirname(target),{recursive:true});await cp(source,target,{force:false,errorOnExist:true});}};await walk(sourceRoot);
}
