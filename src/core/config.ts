import process from 'node:process';
import { resolve } from 'node:path';
import { readChatModelConfig } from '../agent/chat-model.js';

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function num(name: string, fallback: number): number {
  const parsed = Number(env(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNum(name: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(num(name, fallback))));
}

export const config = {
  chatModel: readChatModelConfig(process.env),
  onebot: {
    httpUrl: env('ONEBOT_HTTP_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    wsUrl: env('ONEBOT_WS_URL', 'ws://127.0.0.1:3001'),
    token: env('ONEBOT_TOKEN'),
  },
  dsh: {
    bin: /[\\/]/.test(env('BOT_DSH_BIN')) ? resolve(env('BOT_DSH_BIN')) : env('BOT_DSH_BIN', 'dsh.cmd'),
    profile: env('BOT_DSH_PROFILE', 'acp'),
    home: env('BOT_DSH_HOME') ? resolve(env('BOT_DSH_HOME')) : '',
    workspace: resolve(env('BOT_WORKSPACE', 'bot-workspace')),
  },
  bot: {
    selfId: num('BOT_SELF_ID', 0),
    adminQq: num('ADMIN_QQ', 0),
    groupPrefix: env('GROUP_PREFIX'),
    groupCooldownMs: num('GROUP_COOLDOWN_MS', 3000),
    chunkSize: num('REPLY_CHUNK_SIZE', 600),
    minDelayMs: num('MIN_DELAY_MS', 700),
    maxDelayMs: num('MAX_DELAY_MS', 2400),
    turnTimeoutMs: Math.max(1000, Math.min(600_000, num('TURN_TIMEOUT_MS', 180_000))),
    allowExec: env('ALLOW_EXEC') === '1',
    groupContextLines: num('GROUP_CONTEXT_LINES', 6),
    queuePerConversation: boundedNum('QUEUE_PER_CONVERSATION', 5, 1, 100),
    queueTotal: boundedNum('QUEUE_TOTAL', 50, 1, 1000),
    maxConcurrentTurns: boundedNum('MAX_CONCURRENT_TURNS', 4, 1, 32),
    ingressPerConversation: boundedNum('INGRESS_PER_CONVERSATION', 50, 1, 1000),
    ingressTotal: boundedNum('INGRESS_TOTAL', 500, 1, 10000),
    ingressMaxBytes: boundedNum('INGRESS_MAX_BYTES', 16 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    batchMaxBytes: boundedNum('BATCH_MAX_BYTES', 64 * 1024, 1024, 1024 * 1024),
  },
};
