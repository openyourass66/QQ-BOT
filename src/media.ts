import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile, writeFile, mkdir, stat, realpath, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { SocialSettings } from './social-settings.js';

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Restrict IPv6 to global unicast, excluding embedded IPv4 and local ranges.
  return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:)/i.test(address);
}
export async function downloadPublic(raw: string, signal: AbortSignal, maxBytes = 12_000_000, redirects = 0): Promise<{ buffer: Buffer; mime: string }> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || redirects > 4) throw new Error('媒体地址无效');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('不允许从媒体工具访问本机或内网地址');
  signal.throwIfAborted();
  const chosen = addresses[0];
  return new Promise((done, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => opts.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family)) as never,
      headers: { 'user-agent': 'QQ-BOT/0.2' },
    }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume(); void downloadPublic(new URL(response.headers.location, url).href, signal, maxBytes, redirects + 1).then(done, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`媒体下载失败 (${response.statusCode})`)); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) response.destroy(new Error('媒体超过大小上限')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => done({ buffer: Buffer.concat(chunks), mime: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0] }));
    });
    request.once('error', reject);
  });
}

export function imageMime(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0,6).toString())) return 'image/gif';
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  throw new Error('不是受支持的 PNG/JPEG/GIF/WebP 图片');
}

export class MediaService {
  readonly root: string;
  constructor(root: string, private readonly settings: () => SocialSettings) { this.root = resolve(root); }
  async save(buffer: Buffer, extension: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const file = resolve(this.root, createHash('sha256').update(buffer).digest('hex') + extension);
    if (await stat(file).then(s => s.isFile(), () => false)) return file;
    let total = 0;
    for (const name of await readdir(this.root)) total += await stat(resolve(this.root,name)).then(s => s.isFile() ? s.size : 0, () => 0);
    const limit = Number(process.env.BOT_MEDIA_MAX_BYTES || 536870912);
    if (!Number.isFinite(limit) || total + buffer.length > limit) throw new Error('媒体库空间额度不足，请清理不再使用的媒体或调整 BOT_MEDIA_MAX_BYTES');
    await writeFile(file, buffer); return file;
  }
  async bytes(source: string, signal: AbortSignal, max = 12_000_000): Promise<{ buffer: Buffer; mime: string }> {
    if (/^https?:\/\//i.test(source)) return downloadPublic(source, signal, max);
    const file = await realpath(source.startsWith('file:') ? fileURLToPath(source) : resolve(source));
    // Only files created by this service can be read or sent by a model.
    const roots = [this.root, resolve(process.env.BOT_WORKSPACE || 'bot-workspace', 'output'), ...(process.env.BOT_MEDIA_IMPORT_DIRS ?? '').split('|').filter(Boolean)];
    let allowed = false;
    for (const root of roots) {
      const actual = await realpath(root).catch(() => resolve(root));
      const rel = relative(actual, file);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { allowed = true; break; }
    }
    if (!allowed) throw new Error('文件不在机器人媒体库或已配置的媒体导入目录中');
    const info = await stat(file); if (!info.isFile() || info.size > max) throw new Error('媒体文件无效或过大');
    return { buffer: await readFile(file), mime: 'application/octet-stream' };
  }
  async image(source: string, signal: AbortSignal): Promise<{ type: 'image'; data: string; mimeType: string }> {
    const { buffer } = await this.bytes(source, signal);
    return { type: 'image', data: buffer.toString('base64'), mimeType: imageMime(buffer) };
  }
  private endpoint(path: string): URL {
    if (!process.env.BOT_MEDIA_BASE_URL) throw new Error('额外媒体服务未配置；请配置媒体服务地址与所需模型');
    const base = new URL(process.env.BOT_MEDIA_BASE_URL.replace(/\/?$/, '/'));
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('媒体服务地址必须为 HTTP(S)');
    return new URL(path, base);
  }
  private headers(): Record<string, string> { return process.env.BOT_MEDIA_API_KEY ? { authorization: `Bearer ${process.env.BOT_MEDIA_API_KEY}` } : {}; }
  async vision(images: Array<{ data: string; mimeType: string }>, question: string, signal: AbortSignal): Promise<unknown> {
    const model = this.settings().visionModel;
    if (!model) return { content: [{ type: 'text', text: '以下图片交给当前 Agent 的视觉能力处理；若当前模型不支持图片，请明确说明。' }, ...images.map(i => ({ type: 'image', ...i }))] };
    const response = await fetch(this.endpoint('chat/completions'), { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: question }, ...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))] }] }) });
    const result = await response.json() as { choices?: Array<{ message: { content: string } }> };
    if (!response.ok || !result.choices?.[0]) throw new Error(`视觉服务调用失败 (${response.status})`);
    return { text: result.choices[0].message.content };
  }
  async transcribe(source: string, signal: AbortSignal): Promise<unknown> {
    const model = this.settings().transcriptionModel; if (!model) throw new Error('语音转写模型未配置');
    const { buffer } = await this.bytes(source, signal, 25_000_000);
    const form = new FormData(); form.set('model', model); form.set('file', new Blob([new Uint8Array(buffer)]), 'voice.wav');
    const response = await fetch(this.endpoint('audio/transcriptions'), { method: 'POST', headers: this.headers(), body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) throw new Error(`语音转写失败 (${response.status})`);
    return response.json();
  }
  async speech(text: string, signal: AbortSignal): Promise<string> {
    const s = this.settings(); if (!s.speechModel) throw new Error('语音合成模型未配置');
    const response = await fetch(this.endpoint('audio/speech'), { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), body: JSON.stringify({ model: s.speechModel, voice: s.speechVoice, input: text, response_format: 'mp3' }) });
    if (!response.ok) throw new Error(`语音合成失败 (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 25_000_000) throw new Error('合成语音过大');
    return this.save(buffer, '.mp3');
  }
  async video(source: string, question: string, signal: AbortSignal): Promise<unknown> {
    if (!process.env.BOT_FFMPEG_BIN) throw new Error('视频抽帧未配置；请设置 FFmpeg 启动文件');
    const { buffer } = await this.bytes(source, signal, 50_000_000);
    const input = await this.save(buffer, '.video');
    const prefix = createHash('sha256').update(buffer).digest('hex');
    const output = resolve(this.root, `${prefix}-%02d.jpg`);
    const count = this.settings().videoFrames;
    await new Promise<void>((done, reject) => {
      const child = spawn(process.env.BOT_FFMPEG_BIN!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', 'fps=1/3,scale=640:-2', '-frames:v', String(count), output], { windowsHide: true, stdio: 'ignore', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) });
      child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('视频解码失败')));
    });
    const images = [];
    for (let i = 1; i <= count; i++) { try { images.push(await this.image(resolve(this.root, `${prefix}-${String(i).padStart(2,'0')}.jpg`), signal)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; } }
    if (!images.length) throw new Error('未取得视频画面');
    return this.vision(images, question, signal);
  }
  capabilities(): Record<string, string> {
    const s = this.settings();
    return { images: s.visionModel && process.env.BOT_MEDIA_BASE_URL ? '已配置独立视觉服务' : '图片通过 MCP 交给 DSH，需当前模型支持视觉', transcription: s.transcriptionModel && process.env.BOT_MEDIA_BASE_URL ? '已配置' : '未配置', speech: s.speechModel && process.env.BOT_MEDIA_BASE_URL ? '已配置' : '未配置', video: process.env.BOT_FFMPEG_BIN ? '已配置抽帧' : '未配置 FFmpeg', search: process.env.BOT_SEARCH_URL ? '已配置搜索服务' : '使用 DSH 已挂载的搜索/浏览工具；本 QQ 工具未配置搜索服务', qzone: process.env.BOT_QZONE_ADAPTER_URL ? '已配置空间适配服务' : '发布依赖协议端扩展；浏览/评论未配置适配服务' };
  }
}
