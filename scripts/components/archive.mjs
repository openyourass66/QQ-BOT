import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readlink, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const hosts = new Set(['nodejs.org', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function allowedUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.hostname) || url.port && url.port !== '443') throw new Error('组件下载地址不在官方来源清单中');
  return url;
}
/** 运行系统打包工具；输出用于校验条目或报告失败原因。 */
function runTool(command, args, { cwd, signal } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errors = '', bytes = 0, failure;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 67108864) { failure = new Error('组件解压输出超过限制'); child.kill(); return; }
      out += chunk;
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-16000); });
    child.once('error', error => { failure = error; if (!child.pid) reject(error); });
    child.once('close', code => failure ? reject(failure) : code === 0 ? done(out) : reject(new Error(`组件解压失败（退出码 ${code}）：${errors.trim().slice(0, 300)}`)));
  });
}

function posixName(name) {
  const clean = name.replace(/\/+$/, '');
  if (!clean || clean.startsWith('/') || clean.includes('\\') || clean.includes('\0')) throw new Error('组件包包含不安全的文件路径');
  if (clean.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('组件包包含不安全的文件路径');
  return clean;
}

/** 拒绝解压结果中指向目录外部的符号链接。 */
export async function assertContainedLinks(root, { maxEntries = 60000 } = {}) {
  const base = await realpath(root);
  const pending = [base];
  let count = 0;
  while (pending.length) {
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      if (++count > maxEntries) throw new Error('组件文件数量超过限制');
      const path = join(entry.parentPath ?? entry.path, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const rel = relative(base, resolve(dirname(path), await readlink(path)));
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('组件包包含指向外部的链接');
      } else if (info.isDirectory()) pending.push(path);
    }
  }
}

/** 解压官方 tar.gz 组件包；条目名称先整体校验，再按清单前缀剥离。 */
export async function extractTarGz(archive, destination, { prefix = '', signal, maxFiles = 30000 } = {}) {
  const entries = (await runTool('tar', ['-tzf', archive], { signal })).split('\n').map(line => line.trim()).filter(Boolean);
  if (entries.length > maxFiles) throw new Error('组件包文件数量超过限制');
  const cleanPrefix = prefix.replace(/\/+$/, '');
  const seen = new Set();
  for (const entry of entries) {
    const name = posixName(entry);
    if (cleanPrefix && name !== cleanPrefix && !name.startsWith(`${cleanPrefix}/`)) throw new Error('组件包目录结构与清单不匹配');
    const rel = cleanPrefix ? name.slice(cleanPrefix.length).replace(/^\//, '') : name;
    if (rel && seen.has(rel)) throw new Error('组件包包含重复文件');
    if (rel) seen.add(rel);
  }
  await mkdir(destination);
  const strip = cleanPrefix ? `--strip-components=${cleanPrefix.split('/').length}` : undefined;
  await runTool('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions', ...(strip ? [strip] : [])], { signal });
  await assertContainedLinks(destination);
}

/** 通过 AppImage 自带运行时解包，无需 FUSE；解包后仍要求可执行入口。 */
export async function extractAppImage(archive, workDir, destination, { signal } = {}) {
  await chmod(archive, 0o700);
  await runTool(archive, ['--appimage-extract'], { cwd: workDir, signal });
  const root = join(workDir, 'squashfs-root');
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('组件包解压结构不受支持');
  await assertContainedLinks(root);
  for (const name of ['AppRun', 'qq']) await chmod(join(root, name), 0o755);
  await rename(root, destination);
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** 下载和本地导入均校验固定清单，临时文件由调用者拥有。 */
export async function obtainArchive(spec, destination, { signal, archivePath, fetcher = fetch, onProgress = () => {}, attempts = 2 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.size) || spec.size <= 0) throw new Error('组件摘要或大小清单无效');
  allowedUrl(spec.url);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    const output = await open(destination, 'wx');
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('下载长时间没有进展，请重试或导入本地组件包')), 30000); };
    try {
      let source;
      if (archivePath) source = createReadStream(archivePath);
      else {
        let url = allowedUrl(spec.url), response;
        arm();
        for (let redirects = 0; ; redirects++) {
          response = await fetcher(url, { redirect: 'manual', signal: combined, headers: { 'user-agent': 'WhaleWorkbench-components' } });
          if (![301,302,303,307,308].includes(response.status)) break;
          await response.body?.cancel();
          if (redirects >= 4 || !response.headers.get('location')) throw new Error('组件下载重定向过多或无效');
          url = allowedUrl(new URL(response.headers.get('location'), url));
        }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`官方下载服务返回 HTTP ${response.status}`); }
        source = Readable.fromWeb(response.body);
      }
      let bytes = 0;
      const hash = createHash('sha256');
      arm();
      const meter = new Transform({ transform(chunk, encoding, done) {
        bytes += chunk.length; arm();
        if (bytes > spec.size) return done(new Error('组件包超过清单大小，已拒绝'));
        hash.update(chunk); onProgress({ received: bytes, total: spec.size }); done(null, chunk);
      } });
      await pipeline(source, meter, output.createWriteStream(), { signal: combined });
      if (bytes !== spec.size || hash.digest('hex') !== spec.sha256) throw new Error('组件包大小或 SHA-256 不匹配，已拒绝；请重新下载官方版本');
      return;
    } catch (error) {
      await output.close().catch(() => {});
      await rm(destination, { force: true });
      if (signal?.aborted) signal.throwIfAborted();
      if (archivePath || attempt === attempts || /不匹配|超过清单|官方来源|重定向/.test(error.message)) throw error;
      onProgress({ received: 0, total: spec.size, retry: attempt });
    } finally { clearTimeout(timer); await output.close().catch(() => {}); }
  }
}

function safeName(name) {
  const clean = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!clean || clean.split('/').some(part => !part || part === '.' || part === '..' || /[\\<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) throw new Error('组件包包含不安全的文件路径');
  return clean;
}

/** 只解压到新建目录，不接受链接、覆盖、大小写别名或无限解压。 */
export async function extractZip(archive, destination, { prefix = '', signal, maxFiles = 30000, maxBytes = 1073741824, maxFileBytes = 536870912 } = {}) {
  const { default: yauzl } = await import('yauzl');
  await mkdir(destination);
  const zip = await yauzl.openPromise(archive, { strictFileNames: true, validateEntrySizes: true });
  let count = 0, declared = 0, actual = 0;
  const names = new Map();
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (++count > maxFiles) throw new Error('组件包文件数量超过限制');
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.isEncrypted() || ![0,0o100000,0o040000].includes(kind)) throw new Error('组件包包含链接、加密或特殊文件');
      safeName(entry.fileName);
      if (prefix && entry.fileName === prefix) continue;
      if (!entry.fileName.startsWith(prefix)) throw new Error('组件包目录结构与清单不匹配');
      const name = safeName(entry.fileName.slice(prefix.length));
      const directory = entry.fileName.endsWith('/');
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/'), key = path.toLowerCase(), isDir = i < parts.length || directory;
        const previous = names.get(key);
        if (previous && (previous.path !== path || !previous.directory || !isDir)) throw new Error('组件包含重复文件或大小写路径冲突');
        names.set(key, { path, directory: isDir });
      }
      const target = resolve(destination, name), rel = relative(destination, target);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('组件解压路径越界');
      if (directory) { await mkdir(target, { recursive: true }); continue; }
      declared += entry.uncompressedSize;
      if (entry.uncompressedSize > maxFileBytes || declared > maxBytes) throw new Error('组件解压大小超过限制');
      await mkdir(dirname(target), { recursive: true });
      const source = await zip.openReadStreamPromise(entry);
      const meter = new Transform({ transform(chunk, encoding, done) { actual += chunk.length; done(actual > maxBytes ? new Error('组件实际解压大小超过限制') : null, chunk); } });
      await pipeline(source, meter, createWriteStream(target, { flags: 'wx' }), { signal });
    }
    return { files: count, bytes: actual };
  } finally { zip.close(); }
}
