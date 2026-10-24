import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { knowledge } from '../desktop/knowledge.mjs';

test('人设库：多条命名保存、重载、修改、删除和显式应用全局人设', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-persona-library-'));
  try {
    await writeFile(join(root, 'AGENTS.md'), '原本的全局人设');
    let view = await knowledge(root);
    const first = await knowledge(root, { op: 'save_preset', name: ' 日常陪伴 ', text: '温和地交流。', libraryRevision: view.libraryRevision });
    const id = first.presets[0].id;
    view = await knowledge(root, { op: 'save_preset', name: '工作助手', text: '认真回答。'.repeat(600), libraryRevision: first.libraryRevision });
    assert.equal(view.presets.length, 2);
    assert.equal(view.presets[0].name, '日常陪伴');
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '原本的全局人设');
    assert.equal((await knowledge(root)).presets.length, 2);
    await assert.rejects(knowledge(root, { op: 'save_preset', name: '日常陪伴', text: '重名', libraryRevision: view.libraryRevision }), /同名/);
    await assert.rejects(knowledge(root, { op: 'save_preset', name: '长内容', text: 'x'.repeat(10001), libraryRevision: view.libraryRevision }), /10000/);
    await assert.rejects(knowledge(root, { op: 'save_preset', id, name: '日常陪伴', text: '过期修改', libraryRevision: first.libraryRevision }), /其他操作修改/);
    view = await knowledge(root, { op: 'save_preset', id, name: '轻松聊天', text: '轻松地交流。', expectedText: '温和地交流。', expectedName: '日常陪伴', libraryRevision: view.libraryRevision });
    await assert.rejects(knowledge(root, { op: 'save_preset', id, name: '草稿', text: '旧草稿', expectedText: '温和地交流。', libraryRevision: view.libraryRevision }), /其他操作修改/);
    view = await knowledge(root, { op: 'apply_preset', id, revision: view.globalRevision });
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '轻松地交流。');
    view = await knowledge(root, { op: 'delete_preset', id, libraryRevision: view.libraryRevision });
    assert.equal(view.presets.length, 1);
    assert.equal(view.global, '轻松地交流。');
    await assert.rejects(knowledge(root, { op: 'list', workspace: join(root, 'other') }), /工作区已变更/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工作区记忆：文件新建、嵌套目录、内容搜索、编辑、冲突保护和删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-workspace-memory-'));
  try {
    let view = await knowledge(root, { op: 'save_memory', name: 'people/friend.md', text: '喜欢读书\n不喝咖啡', revision: null });
    assert.equal(view.files[0].name, 'people/friend.md');
    const original = view.file;
    await knowledge(root, { op: 'save_memory', name: 'notes.txt', text: '另一条记录', revision: null });
    assert.deepEqual((await knowledge(root, { op: 'list', query: '咖啡' })).files.map(file => file.name), ['people/friend.md']);
    view = await knowledge(root, { op: 'read_memory', name: original.name });
    assert.equal(view.file.text, original.text);
    await assert.rejects(knowledge(root, { op: 'save_memory', name: original.name, text: '重复新建', revision: null }), /其他操作修改/);
    view = await knowledge(root, { op: 'save_memory', name: original.name, text: '更新后的记忆', revision: original.revision });
    await assert.rejects(knowledge(root, { op: 'save_memory', name: original.name, text: '过期草稿', revision: original.revision }), /其他操作修改/);
    await assert.rejects(knowledge(root, { op: 'delete_memory', name: original.name, revision: original.revision }), /其他操作修改/);
    assert.equal(await readFile(join(root, 'memory/people/friend.md'), 'utf8'), '更新后的记忆');
    await knowledge(root, { op: 'delete_memory', name: original.name, revision: view.file.revision });
    assert.equal((await knowledge(root)).files.length, 1);
    for (const name of ['../AGENTS.md', 'a/../../outside.md', 'C:/outside.md', '/outside.md', 'x.json', 'con.md', 'space ./x.md']) {
      await assert.rejects(knowledge(root, { op: 'save_memory', name, text: 'bad', revision: null }), /文件名|工作区/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工作区文件管理拒绝目录链接越界，外部文件保持原样', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-memory-links-'));
  const external = await mkdtemp(join(tmpdir(), 'qq-memory-external-'));
  try {
    await mkdir(join(root, 'memory'));
    await writeFile(join(external, 'outside.md'), '外部内容');
    await symlink(external, join(root, 'memory/link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await knowledge(root)).files.length, 0);
    await assert.rejects(knowledge(root, { op: 'read_memory', name: 'link/outside.md' }), /链接/);
    await assert.rejects(knowledge(root, { op: 'save_memory', name: 'link/outside.md', text: 'bad', revision: null }), /链接/);
    await symlink(external, join(root, '.whale'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(knowledge(root), /链接/);
    assert.equal(await readFile(join(external, 'outside.md'), 'utf8'), '外部内容');
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});

test('全局人设保留外部编辑；人设库损坏时保留原文件且不阻止其他配置加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-knowledge-worker-'));
  const worker = (action, data) => new Promise((done, reject) => {
    const child = fork(resolve('desktop/config-worker.mjs'), [], { cwd: root, silent: true, execArgv: [], env: { ...process.env, BOT_SETTINGS_FILE: join(root, 'bot.config.json'), BOT_WORKSPACE: root } });
    let reply; child.once('message', value => { reply = value; }); child.once('exit', () => done(reply)); child.once('error', reject); child.send({ action, data });
  });
  try {
    await writeFile(join(root, 'AGENTS.md'), '初始人设');
    let view = await knowledge(root);
    await writeFile(join(root, 'AGENTS.md'), '外部编辑');
    await assert.rejects(knowledge(root, { op: 'save_global', text: '旧草稿', revision: view.globalRevision }), /其他操作修改/);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '外部编辑');
    let response = await worker('knowledge', { op: 'save_preset', name: '助手', text: '你好', libraryRevision: null });
    assert.equal(response.ok, true);
    response = await worker('load');
    assert.equal(response.result.knowledge.presets[0].name, '助手');
    await writeFile(join(root, '.whale/personas.json'), '{broken');
    await assert.rejects(knowledge(root), /损坏/);
    response = await worker('load');
    assert.equal(response.ok, true);
    assert.equal(response.result.persona, '外部编辑');
    assert.match(response.result.knowledge.error, /损坏/);
    assert.equal(await readFile(join(root, '.whale/personas.json'), 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});
