import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChatModelConfig, normalizeChatBaseUrl, chatModelPatches, chatModelSelection, prepareChatModelPatch, listChatModels, testChatModel } from '../dist/agent/chat-model.js';

test('项目模型配置：独立凭据引用、不在覆盖文件中写入密钥、兼容沿用 Profile', async () => {
  assert.equal(chatModelSelection(readChatModelConfig({})), undefined);
  assert.deepEqual(chatModelPatches(readChatModelConfig({})), []);
  assert.throws(() => readChatModelConfig({ BOT_CHAT_MODE: 'project' }), /API Key/);
  assert.throws(() => readChatModelConfig({ BOT_CHAT_MODE: 'unknown' }), /使用方式/);
  assert.throws(() => readChatModelConfig({ BOT_CHAT_MODE: 'account', BOT_CHAT_MODEL: 'bad model' }), /模型 ID/);
  const env = { BOT_CHAT_MODE: 'project', BOT_CHAT_MODEL: 'custom-flash', QQ_BOT_DEEPSEEK_API_KEY: 'project-test-key' };
  for (const url of ['file:///x', 'https://name:pass@example.test', 'https://example.test/?key=x', 'https://example.test/#x']) {
    assert.throws(() => readChatModelConfig({ ...env, BOT_CHAT_BASE_URL: url }), /API 地址/);
  }
  const config = readChatModelConfig(env);
  assert.deepEqual(chatModelSelection(config), { provider: 'deepseek-official', model: 'custom-flash' });
  const dir = await mkdtemp(join(tmpdir(), 'qq-chat-patch-'));
  try {
    assert.equal(await prepareChatModelPatch(readChatModelConfig({}), join(dir, 'sessions.json')), undefined);
    const path = await prepareChatModelPatch(config, join(dir, 'sessions.json'));
    const content = await readFile(path, 'utf8');
    assert.ok(!content.includes(config.apiKey));
    const patch = JSON.parse(content);
    assert.equal(patch.find(p => p.id === 'llm-deepseek').config.apiKeyEnv, 'QQ_BOT_DEEPSEEK_API_KEY');
    assert.equal(patch.find(p => p.id === 'acp').config.model, 'custom-flash');
    assert.equal(patch.find(p => p.id === 'web-search-deepseek').config.apiKeyEnv, 'QQ_BOT_DEEPSEEK_API_KEY');
    const account = chatModelPatches(readChatModelConfig({ BOT_CHAT_MODE: 'account' }));
    assert.equal(account.find(p => p.id === 'acp').config.provider, 'deepseek-account');
    assert.ok(!account.some(p => p.id === 'llm-deepseek'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('模型连接：使用输入的项目 Key、Messages 实际回复、模型获取、错误脱敏', async () => {
  const calls = [];
  let status = 200, invalid = false;
  const http = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status !== 200 ? { error: { message: 'project-test-key' } } : req.method === 'GET'
      ? { data: [{ id: 'flash' }, { id: 'pro' }, { id: 'flash' }, { id: '\nwrong' }] }
      : invalid ? { choices: [] } : { content: [{ type: 'text', text: 'OK' }] }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const config = readChatModelConfig({ BOT_CHAT_MODE: 'project', BOT_CHAT_MODEL: 'flash', QQ_BOT_DEEPSEEK_API_KEY: 'project-test-key', BOT_CHAT_BASE_URL: `http://127.0.0.1:${http.address().port}/anthropic` });
  try {
    assert.deepEqual(await listChatModels(config), ['flash', 'pro']);
    const result = await testChatModel(config); assert.equal(result.model, 'flash');
    assert.equal(calls[0].url, '/models'); assert.equal(calls[1].url, '/anthropic/v1/messages');
    assert.equal(calls[1].headers['x-api-key'], config.apiKey); assert.equal(calls[1].body.model, 'flash');
    assert.equal(calls[1].body.thinking.type, 'disabled');
    invalid = true; await assert.rejects(testChatModel(config), /Messages/);
    status = 401; await assert.rejects(testChatModel(config), error => /HTTP 401/.test(error.message) && !error.message.includes(config.apiKey));
    status = 402; await assert.rejects(testChatModel(config), /余额不足/);
    await assert.rejects(listChatModels(readChatModelConfig({ BOT_CHAT_MODE: 'account' })), /本项目 API Key/);
  } finally { http.closeAllConnections(); await new Promise(done => http.close(done)); }
});

test('官方根地址和 /v1 自动转为 Messages 入口，测试、保存和运行使用相同地址', async t => {
  const expected = 'https://api.deepseek.com/anthropic';
  const env = { BOT_CHAT_MODE: 'project', QQ_BOT_DEEPSEEK_API_KEY: 'project-fixture-key' };
  for (const url of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', ' https://api.deepseek.com/v1/ ']) {
    const config = readChatModelConfig({ ...env, BOT_CHAT_BASE_URL: url });
    assert.equal(config.baseUrl, expected);
    assert.equal(chatModelPatches(config).find(p => p.id === 'llm-deepseek').config.baseURL, expected);
  }
  for (const url of ['https://proxy.example.test', 'https://proxy.example.test/v1', 'https://api.deepseek.com:444', expected, expected + '/v1', 'https://api.deepseek.com.example.test']) {
    assert.equal(normalizeChatBaseUrl(url), url);
  }
  assert.throws(() => readChatModelConfig({ ...env, BOT_CHAT_BASE_URL: 'https://api.deepseek.com/?key=x' }), /API 地址/);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    return new Response(JSON.stringify(options.method === 'GET' ? { data: [{ id: 'deepseek-flash' }] } : { content: [{ type: 'text', text: 'OK' }] }), { headers: { 'content-type': 'application/json' } });
  });
  const config = readChatModelConfig({ ...env, BOT_CHAT_BASE_URL: 'https://api.deepseek.com' });
  await listChatModels(config); await testChatModel(config);
  assert.deepEqual(calls, ['https://api.deepseek.com/models', expected + '/v1/messages']);
  const { mergeRuntimeEnv, validateRuntimeEnv } = await import('../desktop/runtime-fields.mjs');
  const saved = mergeRuntimeEnv('', { ...env, BOT_CHAT_BASE_URL: 'https://api.deepseek.com' });
  assert.match(saved, /BOT_CHAT_BASE_URL='https:\/\/api.deepseek.com\/anthropic'/);
  validateRuntimeEnv(saved);
});
