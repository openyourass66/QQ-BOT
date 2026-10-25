import { existsSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--noEmitOnError'], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);

// Only prune compiler output after a successful build; preserve other files.
const dist = join(root, 'dist');
let removed = 0;
function prune(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      prune(path);
      if (readdirSync(path).length === 0) rmdirSync(path);
    } else if (entry.isFile() && /\.js(?:\.map)?$/.test(entry.name)) {
      const source = join(root, 'src', relative(dist, path).replace(/\.js(?:\.map)?$/, '.ts'));
      if (!existsSync(source)) { unlinkSync(path); removed++; }
    }
  }
}
prune(dist);
if (removed) console.log(`已清理 ${removed} 个过期构建文件。`);
