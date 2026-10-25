import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function setup(root) {
  const created = [];
  async function copyMissing(source, destination) {
    try {
      await copyFile(join(root, source), join(root, destination), constants.COPYFILE_EXCL);
      created.push(destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  await copyMissing('.env.example', '.env');
  await mkdir(join(root, 'bot-workspace'), { recursive: true });
  await copyMissing('templates/bot-persona.md', 'bot-workspace/AGENTS.md');
  return created;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const created = await setup(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(created.length ? `已创建：${created.join('、')}` : '已有配置与人设已保留。');
}
