import { readFile, writeFile, rename, mkdir, readdir, lstat, realpath, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = message => { throw new Error('管理操作失败：' + message); };
const revision = text => createHash('sha256').update(text).digest('hex');
const optionalRead = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const textValue = (value, max, label, empty = false) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) fail(`${label}不能为空，且最多 ${max} 字`);
  return value;
};
const inside = (base, path) => { const child = relative(base, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)); };

async function scopedPath(workspace, name) {
  const base = await realpath(workspace);
  const path = resolve(base, name);
  if (!inside(base, path)) fail('文件必须位于当前工作区内');
  let current = base;
  for (const part of relative(base, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) fail('不能通过链接访问工作区外的文件');
  }
  return path;
}

async function replace(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.desktop.tmp';
  try { await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function checkRevision(text, expected) {
  if ((text === null ? null : revision(text)) !== expected) fail('内容已被其他操作修改，请刷新后核对；当前编辑仍保留');
}

function parseLibrary(raw) {
  if (raw === null) return [];
  if (raw.length > 2000000) fail('人设库过大，请拆分或精简内容；原文件保留');
  let data;
  try { data = JSON.parse(raw); } catch { fail('人设库文件损坏，请修复文件后刷新；原文件保留'); }
  if (data?.version !== 1 || !Array.isArray(data.personas) || data.personas.length > 1000) fail('人设库格式无效；原文件保留');
  const ids = new Set();
  for (const item of data.personas) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Number.isFinite(item.updatedAt)) fail('人设库格式无效；原文件保留');
    textValue(item.name, 64, '人设名称'); textValue(item.text, 10000, '人设内容'); ids.add(item.id);
  }
  return data.personas;
}

async function memoryFiles(workspace, query = '') {
  const root = await scopedPath(workspace, 'memory');
  const files = [];
  async function walk(path, prefix = '', depth = 0) {
    if (depth > 8 || files.length >= 500) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (files.length >= 500) break;
      if (entry.isSymbolicLink()) continue;
      const name = prefix + entry.name, file = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(file, name + '/', depth + 1);
      else if (entry.isFile() && ['.md', '.txt'].includes(extname(entry.name).toLowerCase())) {
        const info = await lstat(file);
        let preview = '';
        if (query && !name.toLowerCase().includes(query.toLowerCase())) {
          if (info.size > 400000) continue;
          const text = await readFile(file, 'utf8'), index = text.toLowerCase().indexOf(query.toLowerCase());
          if (index < 0) continue;
          preview = text.slice(Math.max(0, index - 20), index + 140).replace(/[\r\n]/g, ' ');
        }
        files.push({ name, size: info.size, updatedAt: info.mtimeMs, preview });
      }
    }
  }
  await walk(root);
  return files;
}

function memoryName(value) {
  const name = textValue(value, 200, '文件名').replaceAll('\\', '/');
  if (!['.md', '.txt'].includes(extname(name).toLowerCase()) || name.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('请使用工作区记忆目录内的 .md 或 .txt 文件名');
  return name;
}

export async function knowledge(workspacePath, input = { op: 'list' }) {
  const workspace = resolve(workspacePath);
  if (input.workspace && resolve(input.workspace) !== workspace) fail('工作区已变更，请重新打开工作台后编辑');
  if (!['list', 'save_preset', 'delete_preset', 'save_global', 'apply_preset', 'read_memory', 'save_memory', 'delete_memory'].includes(input.op)) fail('未知的管理操作');
  await mkdir(workspace, { recursive: true });
  const libraryPath = await scopedPath(workspace, '.whale/personas.json');
  const personaPath = await scopedPath(workspace, 'AGENTS.md');
  let raw = await optionalRead(libraryPath), presets = parseLibrary(raw);
  let global = await optionalRead(personaPath), selectedKey;
  if (input.op === 'save_preset' || input.op === 'delete_preset') {
    checkRevision(raw, input.libraryRevision);
    const original = presets.find(item => item.id === input.id);
    if (original && ((input.expectedText !== undefined && input.expectedText !== original.text) || (input.expectedName !== undefined && input.expectedName !== original.name))) fail('这条人设已被其他操作修改，请刷新后核对；当前编辑仍保留');
    if (input.op === 'save_preset') {
      const name = textValue(input.name, 64, '人设名称').trim(), text = textValue(input.text, 10000, '人设内容');
      if (presets.some(item => item.id !== input.id && item.name.toLowerCase() === name.toLowerCase())) fail('已有同名人设，请换一个名称');
      if (input.id && !presets.some(item => item.id === input.id)) fail('该人设已被删除，请刷新后再试');
      const item = { id: input.id || randomUUID(), name, text, updatedAt: Date.now() };
      presets = [...presets.filter(preset => preset.id !== item.id), item];
      if (presets.length > 1000) fail('人设库最多保存 1000 条');
      selectedKey = 'preset:' + item.id;
    } else {
      if (!presets.some(item => item.id === input.id)) fail('该人设已被删除，请刷新后再试');
      presets = presets.filter(item => item.id !== input.id); selectedKey = 'global';
    }
    raw = JSON.stringify({ version: 1, personas: presets }, null, 2) + '\n';
    if (raw.length > 2000000) fail('人设库内容过多，请精简后再保存');
    await replace(libraryPath, raw);
  }
  if (input.op === 'save_global' || input.op === 'apply_preset') {
    checkRevision(global, input.revision);
    const preset = presets.find(item => item.id === input.id);
    if (input.op === 'apply_preset' && !preset) fail('该人设已被删除，请刷新后再试');
    global = textValue(input.op === 'apply_preset' ? preset.text : input.text, 100000, '全局人设内容', true);
    await replace(personaPath, global); selectedKey = 'global';
  }
  let file;
  if (['read_memory', 'save_memory', 'delete_memory'].includes(input.op)) {
    const name = memoryName(input.name), path = await scopedPath(workspace, 'memory/' + name);
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.size > 400000)) fail('只能编辑 400 KB 以内的文本记忆文件');
    let text = await optionalRead(path);
    if (input.op === 'read_memory' && text === null) fail('记忆文件已不存在，请刷新列表');
    if (input.op !== 'read_memory') checkRevision(text, input.revision);
    if (input.op === 'save_memory') { text = textValue(input.text, 100000, '记忆内容', true); await replace(path, text); }
    if (input.op === 'delete_memory') { if (text === null) fail('记忆文件已不存在，请刷新列表'); await unlink(path); }
    else file = { name, text, revision: revision(text) };
    selectedKey = input.op === 'delete_memory' ? '' : 'file:' + name;
  }
  const query = typeof input.query === 'string' ? input.query.slice(0,256) : '';
  return { op: input.op, workspace, presets, libraryRevision: raw === null ? null : revision(raw), global: global || '', globalRevision: global === null ? null : revision(global), files: await memoryFiles(workspace, query), ...(file ? { file } : {}), ...(selectedKey !== undefined ? { selectedKey } : {}) };
}
