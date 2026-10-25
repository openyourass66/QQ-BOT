import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { writeFile, mkdir, stat, realpath, readdir, rename, rm, open } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { SocialSettings } from '../qq/social-settings.js';

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

async function readMediaFile(file: string, signal: AbortSignal, max: number): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('媒体文件无效或过大');
    const buffer = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > info.size) throw new Error('媒体文件在读取期间变化，请重试');
    signal.throwIfAborted();
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

export class MediaService {
  readonly root: string;
  private saves: Promise<void> = Promise.resolve();
  constructor(root: string, private readonly settings: () => SocialSettings) { this.root = resolve(root); }
  save(buffer: Buffer, extension: string): Promise<string> {
    const task = this.saves.then(() => this.saveFile(buffer, extension));
    this.saves = task.then(() => undefined, () => undefined);
    return task;
  }
  private async saveFile(buffer: Buffer, extension: string): Promise<string> {
    if (!/^\.[a-z0-9]{1,10}$/i.test(extension)) throw new Error('媒体文件扩展名无效');
    await mkdir(this.root, { recursive: true });
    const file = resolve(this.root, createHash('sha256').update(buffer).digest('hex') + extension);
    if (await stat(file).then(s => s.isFile(), () => false)) return file;
    let total = 0;
    for (const name of await readdir(this.root)) total += await stat(resolve(this.root,name)).then(s => s.isFile() ? s.size : 0, () => 0);
    const limit = Number(process.env.BOT_MEDIA_MAX_BYTES || 536870912);
    if (!Number.isFinite(limit) || total + buffer.length > limit) throw new Error('媒体库空间额度不足，请清理不再使用的媒体或调整 BOT_MEDIA_MAX_BYTES');
    const temp = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, buffer); await rename(temp, file); }
    finally { await rm(temp, { force: true }).catch(() => undefined); }
    return file;
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
    return { buffer: await readMediaFile(file, signal, max), mime: 'application/octet-stream' };
  }
  async image(source: string, signal: AbortSignal): Promise<{ type: 'image'; data: string; mimeType: string }> {
    const { buffer } = await this.bytes(source, signal);
    return { type: 'image', data: buffer.toString('base64'), mimeType: imageMime(buffer) };
  }
  /** Only pass trusted protocol responses for a recorded image or QQ favorite. */
  async onebotImage(result: { file?: unknown; url?: unknown; base64?: unknown }, signal: AbortSignal, localCache = false): Promise<{ type: 'image'; data: string; mimeType: string }> {
    signal.throwIfAborted();
    if (!result || typeof result !== 'object') throw new Error('协议端未返回有效的图片信息');
    const max = 12_000_000;
    let buffer: Buffer | undefined, failure: unknown;
    if (typeof result.base64 === 'string' && result.base64) {
      const encoded = result.base64.replace(/^data:image\/(?:png|jpeg|gif|webp);base64,/i, '');
      if (encoded.length > Math.ceil(max / 3) * 4) throw new Error('协议端返回的图片数据过大');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('协议端返回的图片数据无效');
      buffer = Buffer.from(encoded, 'base64');
      if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('协议端返回的图片数据无效');
    } else if (localCache && typeof result.file === 'string') {
      try {
        const path = result.file.startsWith('file:') ? fileURLToPath(result.file) : result.file;
        if (isAbsolute(path) && !/^[\\/]{2}/.test(path)) buffer = await readMediaFile(await realpath(path), signal, max);
      } catch (error) { signal.throwIfAborted(); failure = error; }
    }
    if (!buffer) {
      for (const source of [result.url, result.file]) {
        if (typeof source !== 'string' || !source) continue;
        try { buffer = (await this.bytes(source, signal, max)).buffer; break; }
        catch (error) { signal.throwIfAborted(); failure ??= error; }
      }
    }
    if (!buffer) throw failure ?? new Error('协议端未返回可读取的图片缓存或图片数据');
    if (buffer.length > max) throw new Error('协议端返回的图片数据过大');
    return { type: 'image', data: buffer.toString('base64'), mimeType: imageMime(buffer) };
  }
  private endpoint(path: string): URL {
    if (!process.env.BOT_MEDIA_BASE_URL) throw new Error('额外媒体服务未配置；请配置媒体服务地址与所需模型');
    const base = new URL(process.env.BOT_MEDIA_BASE_URL.replace(/\/?$/, '/'));
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('媒体服务地址必须为 HTTP(S)');
    return new URL(path, base);
  }
  private headers(): Record<string, string> { return process.env.BOT_MEDIA_API_KEY ? { authorization: `Bearer ${process.env.BOT_MEDIA_API_KEY}` } : {}; }
  private qwenSpeechEndpoint(model: string): URL | undefined {
    const base = this.endpoint('audio/speech');
    if (!['maas.qianwenaiapi.com', 'maas.qwencloudapi.com'].includes(base.hostname) || !/^qwen-audio-\d+\.\d+-tts-(?:flash|plus)(?:-|$)/.test(model)) return undefined;
    return new URL('/api/v1/services/audio/tts/SpeechSynthesizer', base);
  }
  private async audioError(response: Response, label: string): Promise<Error> {
    const body = await response.json().catch(() => null) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    let detail = [body?.code ?? body?.error?.code, body?.message ?? body?.error?.message].filter(v => typeof v === 'string').join('：');
    const key = process.env.BOT_MEDIA_API_KEY;
    if (key) detail = detail.replaceAll(key, '[已隐藏密钥]');
    detail = detail.replace(/Bearer\s+\S+|\bsk-[\w-]+/gi, '[已隐藏密钥]').replace(/[\r\n]+/g, ' ').slice(0, 300);
    if (!detail && response.status === 404) detail = '服务未提供此接口，请核对媒体服务地址、模型和接口协议';
    return new Error(`${label} (${response.status})${detail ? '：' + detail : ''}`);
  }
  private async qwenSpeechAudio(response: Response, signal: AbortSignal): Promise<Buffer> {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw await this.audioError(response, '千问语音合成未返回音频流');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('千问语音合成返回了空音频流');
    const decoder = new TextDecoder(), chunks: Buffer[] = [];
    let pending = '', size = 0, finished = false;
    const event = async (frame: string): Promise<void> => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { finished = true; return; }
      let value: { code?: unknown; error?: unknown; output?: { finish_reason?: unknown; audio?: { data?: unknown } } };
      try { value = JSON.parse(data); } catch { throw new Error('千问语音合成返回了无效的流式事件'); }
      if (!value || typeof value !== 'object') throw new Error('千问语音合成返回了无效的流式事件');
      if (value.code || value.error) throw await this.audioError(Response.json(value), '千问语音合成失败');
      if (value.output?.finish_reason === 'stop') finished = true;
      const encoded = value.output?.audio?.data;
      if (encoded === undefined || encoded === '') return;
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('千问语音合成返回了无效的音频数据');
      if (encoded.length > Math.ceil(25_000_000 / 3) * 4) throw new Error('合成语音过大');
      const buffer = Buffer.from(encoded, 'base64');
      if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('千问语音合成返回了无效的音频数据');
      size += buffer.length;
      if (size > 25_000_000) throw new Error('合成语音过大');
      chunks.push(buffer);
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          await event(pending.slice(0, boundary.index));
          pending = pending.slice(boundary.index + boundary[0].length);
        }
        if (pending.length > 36_000_000) throw new Error('合成语音流式事件过大');
        if (done) break;
      }
      if (pending.trim()) await event(pending);
      signal.throwIfAborted();
      if (!size) throw new Error('千问语音合成未返回音频字节');
      if (!finished) throw new Error('千问语音合成的音频流未完整结束，请重试');
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async vision(images: Array<{ data: string; mimeType: string }>, question: string, signal: AbortSignal): Promise<unknown> {
    const model = this.settings().visionModel;
    if (!model) return { content: [{ type: 'text', text: '以下图片交给当前 Agent 的视觉能力处理；若当前模型不支持图片，请明确说明。' }, ...images.map(i => ({ type: 'image', ...i }))] };
    const response = await fetch(this.endpoint('chat/completions'), { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: question }, ...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))] }] }) });
    const result = await response.json() as { choices?: Array<{ message: { content: string } }> };
    if (!response.ok || typeof result.choices?.[0]?.message?.content !== 'string' || !result.choices[0].message.content.trim()) throw new Error(`视觉服务调用失败或返回空内容 (${response.status})`);
    return { text: result.choices[0].message.content };
  }
  async transcribe(source: string, signal: AbortSignal): Promise<unknown> {
    const model = this.settings().transcriptionModel; if (!model) throw new Error('语音转写模型未配置');
    if (/-tts(?:-|$)/i.test(model)) throw new Error('语音转写模型填成了 TTS 合成模型；请配置服务支持的语音识别（ASR）模型与接口');
    const { buffer } = await this.bytes(source, signal, 25_000_000);
    const form = new FormData(); form.set('model', model); form.set('file', new Blob([new Uint8Array(buffer)]), 'voice.wav');
    const response = await fetch(this.endpoint('audio/transcriptions'), { method: 'POST', headers: this.headers(), body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) throw await this.audioError(response, '语音转写失败');
    return response.json();
  }
  async speech(text: string, signal: AbortSignal): Promise<string> {
    const s = this.settings(); if (!s.speechModel) throw new Error('语音合成模型未配置');
    const qwen = this.qwenSpeechEndpoint(s.speechModel);
    if (qwen && /[\u3400-\u9fff]/u.test(s.speechVoice)) throw new Error('千问合成声音需要填写音色 ID，例如龙安灵希为 longanlingxi，不能填写中文显示名');
    const response = await fetch(qwen ?? this.endpoint('audio/speech'), { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', ...(qwen ? { 'X-DashScope-SSE': 'enable' } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), body: JSON.stringify(qwen
      ? { model: s.speechModel, input: { text, voice: s.speechVoice, format: 'mp3', sample_rate: 24000 } }
      : { model: s.speechModel, voice: s.speechVoice, input: text, response_format: 'mp3' }) });
    if (!response.ok) throw await this.audioError(response, '语音合成失败');
    if (qwen) {
      return this.save(await this.qwenSpeechAudio(response, signal), '.mp3');
    }
    if (/json|text\/|html/i.test(response.headers.get('content-type') ?? '')) throw new Error('语音合成服务返回了文本而非音频，请核对接口协议');
    const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 25_000_000) throw new Error('合成语音过大');
    if (!buffer.length) throw new Error('语音合成返回了空音频');
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
