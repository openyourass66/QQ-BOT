import { readFile, stat, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const specHash = spec => createHash('sha256').update(JSON.stringify(spec)).digest('hex');
export async function componentCatalog(root = programRoot) {
  const catalog = JSON.parse(await readFile(join(root, 'components/catalog.json'), 'utf8'));
  if (catalog.formatVersion !== 1 || catalog.platform !== 'win32-x64' || Object.keys(catalog.components).sort().join() !== 'dsh,napcat,node') throw new Error('组件清单不受支持');
  return catalog;
}
export async function componentState(dataRoot) {
  try { return JSON.parse(await readFile(join(dataRoot, 'components/active.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('组件记录损坏，请保留数据目录并使用组件修复'); }
}
/** 仅识别有安装收据的受管旧路径；不据此把过期版本标记为可用。 */
export async function previousComponentDirectory(id,dataRoot,root=programRoot) {
  if(!Object.hasOwn((await componentCatalog(root)).components,id))throw new Error('未知组件');
  const token=(await componentState(dataRoot))[id];
  if(typeof token!=='string'||!/^[\w.-]+-[a-f0-9]{12}$/.test(token))return undefined;
  const directory=join(dataRoot,'components',id,token);
  try {
    const entry=await lstat(directory),receiptFile=join(directory,'installation.json'),info=await lstat(receiptFile);
    if(!entry.isDirectory()||entry.isSymbolicLink()||!info.isFile()||info.isSymbolicLink()||info.size>65536)return undefined;
    const receipt=JSON.parse(await readFile(receiptFile,'utf8'));
    return /^[a-f0-9]{64}$/.test(receipt.specHash)?directory:undefined;
  }catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
export async function installedComponent(id, dataRoot, root = programRoot) {
  const token = (await componentState(dataRoot))[id];
  if (!token) return undefined;
  const spec = (await componentCatalog(root)).components[id];
  if (!spec) throw new Error('未知组件');
  if (!token || !/^[\w.-]+-[a-f0-9]{12}$/.test(token) || !token.startsWith(spec.version+'-')) return undefined;
  const directory = join(dataRoot, 'components', id, token);
  try {
    const receipt = JSON.parse(await readFile(join(directory,'installation.json'),'utf8'));
    if (receipt.specHash !== specHash(spec)) return undefined;
    for (const name of spec.required) if (!(await stat(join(directory, name))).isFile()) return undefined;
    return { id, directory, spec };
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
