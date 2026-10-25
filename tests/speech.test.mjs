import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaService } from '../dist/services/media.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';

const signal = () => new AbortController().signal;
const event = value => 'event:result\n' + JSON.stringify(value, null, 2).split('\n').map(line => 'data:' + line).join('\n') + '\n\n';
const sse = body => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
async function fixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'qq-speech-'));
  const settings = structuredClone(DEFAULT_SETTINGS.social);
  Object.assign(settings, { speechModel: 'qwen-audio-3.0-tts-flash', speechVoice: 'longanlingxi' });
  const saved = { base: process.env.BOT_MEDIA_BASE_URL, key: process.env.BOT_MEDIA_API_KEY };
  process.env.BOT_MEDIA_BASE_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
  process.env.BOT_MEDIA_API_KEY = 'fixture-private-media-key';
  const media = new MediaService(root, () => settings);
  try { await run({ root, settings, media }); }
  finally {
    t.mock.restoreAll();
    for (const [name, value] of [['BOT_MEDIA_BASE_URL', saved.base], ['BOT_MEDIA_API_KEY', saved.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('千问多行 SSE 跨网络分片拼接音频，无需访问音频下载地址', t => fixture(t, async ({ media }) => {
  const bytes = Buffer.from('ID3fixture-qwen-audio');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.headers['X-DashScope-SSE'], 'enable');
    const raw = new TextEncoder().encode(':keepalive\r\n\r\n' + event({ output: { original_text: '你好', audio: { data: bytes.subarray(0, 4).toString('base64') } } }).replaceAll('\n', '\r\n') + event({ output: { audio: { data: bytes.subarray(4).toString('base64') } } }) + event({ output: { finish_reason: 'stop', audio: { url: 'http://127.0.0.1/unused' } } }) + 'data:[DONE]');
    return sse(new ReadableStream({ start(controller) {
      for (let index = 0; index < raw.length; index += 7) controller.enqueue(raw.subarray(index, index + 7));
      controller.close();
    } }));
  });
  const file = await media.speech('你好', signal());
  assert.match(file, /\.mp3$/);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(calls, 1);
}));

test('千问官方地址使用原生 TTS 请求，拒绝把 JSON 或私网地址保存为语音', t => fixture(t, async ({ root, media }) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer');
    assert.equal(options.headers.authorization, 'Bearer fixture-private-media-key');
    assert.deepEqual(JSON.parse(options.body), { model: 'qwen-audio-3.0-tts-flash', input: { text: '你好', voice: 'longanlingxi', format: 'mp3', sample_rate: 24000 } });
    return sse(event({ output: { audio: { url: 'http://127.0.0.1/private-audio' } } }));
  });
  await assert.rejects(media.speech('你好', signal()), /未返回音频字节/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), []);
}));

test('千问返回缺失或空的音频时不发送 JSON 冒充音频', t => fixture(t, async ({ root, media }) => {
  for (const body of [{}, { output: { audio: { url: '' } } }]) {
    t.mock.method(globalThis, 'fetch', async () => sse(event(body)));
    await assert.rejects(media.speech('你好', signal()), /未返回音频字节/);
  }
  assert.deepEqual(await readdir(root), []);
}));

test('千问音频流报错或无效 Base64 时取消读取并保留服务错误', t => fixture(t, async ({ root, media }) => {
  for (const [body, pattern] of [[event({ code: 'InvalidVoice', message: 'voice not found' }), /InvalidVoice.*voice not found/], [event({ output: { audio: { data: '!invalid!' } } }), /无效的音频数据/], ['data:{broken}\n\n', /无效的流式事件/]]) {
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => sse(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); }, cancel() { cancelled = true; } })));
    await assert.rejects(media.speech('你好', signal()), pattern);
    assert.equal(cancelled, true);
  }
  assert.deepEqual(await readdir(root), []);
}));

test('千问音频流提前中断时不保存或发送半截语音', t => fixture(t, async ({ root, media }) => {
  t.mock.method(globalThis, 'fetch', async () => sse(event({ output: { audio: { data: Buffer.from('ID3partial').toString('base64') } } })));
  await assert.rejects(media.speech('你好', signal()), /未完整结束/);
  assert.deepEqual(await readdir(root), []);
}));

test('中文显示名和识别栏的 TTS 模型会在请求前说明配置错误', t => fixture(t, async ({ settings, media }) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('错误配置不应发送请求'));
  settings.speechVoice = '龙安灵希';
  await assert.rejects(media.speech('你好', signal()), /longanlingxi/);
  settings.transcriptionModel = settings.speechModel;
  await assert.rejects(media.transcribe('unused.wav', signal()), /识别（ASR）/);
}));

test('国际站按原始服务域名调用，不把密钥发给另一地域', t => fixture(t, async ({ media }) => {
  process.env.BOT_MEDIA_BASE_URL = 'https://maas.qwencloudapi.com/compatible-mode/v1/';
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://maas.qwencloudapi.com/api/v1/services/audio/tts/SpeechSynthesizer');
    return Response.json({ message: 'invalid voice' }, { status: 400 });
  });
  await assert.rejects(media.speech('你好', signal()), /400.*invalid voice/);
}));

test('第三方代理与 OpenAI 兼容模型沿用 audio/speech 并保存音频字节', t => fixture(t, async ({ settings, media }) => {
  const bytes = Buffer.from('ID3fixture-audio');
  for (const [base, model] of [['https://proxy.example/v1', 'qwen-audio-3.0-tts-flash'], ['https://maas.qianwenaiapi.com/compatible-mode/v1', 'tts-1']]) {
    process.env.BOT_MEDIA_BASE_URL = base;
    settings.speechModel = model;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(String(url), base + '/audio/speech');
      assert.deepEqual(JSON.parse(options.body), { model, voice: 'longanlingxi', input: '你好', response_format: 'mp3' });
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
    });
    assert.deepEqual(await readFile(await media.speech('你好', signal())), bytes);
  }
}));

test('语音错误保留服务原因并隐藏密钥，404 返回接口提示', t => fixture(t, async ({ media }) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'InvalidParameter', message: 'bad voice fixture-private-media-key Bearer another-private-key' }, { status: 400 }));
  await assert.rejects(media.speech('你好', signal()), error => {
    assert.match(error.message, /400.*InvalidParameter.*bad voice/);
    assert.doesNotMatch(error.message, /fixture-private-media-key|another-private-key/);
    return true;
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(media.speech('你好', signal()), /404.*接口协议/);
}));

test('兼容服务的空音频和文本响应明确失败', t => fixture(t, async ({ media }) => {
  process.env.BOT_MEDIA_BASE_URL = 'https://compatible.example/v1';
  for (const response of [Response.json({ output: { audio: { url: 'https://example.com/audio.mp3' } } }), new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } })]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(media.speech('你好', signal()), /文本而非音频/);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array()));
  await assert.rejects(media.speech('你好', signal()), /空音频/);
}));
