import { readFile, stat } from 'node:fs/promises';
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
