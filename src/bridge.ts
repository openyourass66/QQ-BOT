import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import * as acp from '@agentclientprotocol/sdk';
import { config } from './config.js';
import {
  OneBotHttp,
  OneBotWs,
  segmentsToText,
  stripMention,
  type MessageEvent,
} from './onebot.js';
import { SessionStore } from './store.js';
import { getSettings, loadSettings, watchSettings, saveSettings, type BotSettings } from './settings.js';
import { log, snapshotStatus, status } from './state.js';
import { startAdmin } from './admin.js';

const api = new OneBotHttp(config.onebot.httpUrl, config.onebot.token);
const store = new SessionStore(process.env.SESSION_STORE ?? 'data/sessions.json');
const personaPath = resolve(config.dsh.workspace, 'AGENTS.md');

const sessions = new Map<string, acp.ActiveSession>();
const creating = new Map<string, Promise<acp.ActiveSession>>();
const chains = new Map<string, Promise<unknown>>();
const toolCalls = new Map<string, { title: string; kind: string }>();
const groupHistory = new Map<number, string[]>();
const seen = new Set<number>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const lastGroupReply = new Map<number, number>();

let selfId = config.bot.selfId;
let acpCtx: acp.ClientContext | undefined;
let admin: { close(): Promise<void>; url: string } | undefined;
let readyResolve: (() => void) | undefined;
const ready = new Promise<void>((done) => {
  readyResolve = done;
});

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const rand = (min: number, max: number): number =>
  min + Math.floor(Math.random() * Math.max(1, max - min));

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  chains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function keyOf(event: MessageEvent): string {
  return event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;
}

async function getSession(key: string): Promise<acp.ActiveSession> {
  const existing = sessions.get(key);
  if (existing) return existing;

  const inflight = creating.get(key);
  if (inflight) return inflight;

  const ctx = acpCtx;
  if (!ctx) throw new Error('ACP 还没有就绪');

  const task = (async (): Promise<acp.ActiveSession> => {
    const saved = store.get(key);
    let session: acp.ActiveSession;

    if (saved) {
      try {
        const resumed = await ctx.request(acp.methods.agent.session.resume, {
          sessionId: saved,
          cwd: config.dsh.workspace,
          mcpServers: [],
        });
        // DSH 的 session/resume 响应不带 sessionId，必须补回去，
        // 否则后续 prompt 会发送 sessionId: undefined，报 Invalid params。
        const attach = ctx as unknown as {
          attachSession(response: acp.NewSessionResponse): acp.ActiveSession;
        };
        session = attach.attachSession({
          ...(resumed as Record<string, unknown>),
          sessionId: saved,
        } as unknown as acp.NewSessionResponse);
        log('info', `[acp] resumed ${saved} for ${key}`);
      } catch (error) {
        log('warn', `[acp] resume ${saved} failed, recreating: ${String(error)}`);
        store.delete(key);
        session = await ctx.buildSession({ cwd: config.dsh.workspace, mcpServers: [] }).start();
        store.set(key, session.sessionId);
      }
    } else {
      session = await ctx.buildSession({ cwd: config.dsh.workspace, mcpServers: [] }).start();
      store.set(key, session.sessionId);
      log('info', `[acp] created ${session.sessionId} for ${key}`);
    }

    sessions.set(key, session);
    status.sessions = sessions.size;
    return session;
  })().finally(() => creating.delete(key));

  creating.set(key, task);
  return task;
}

async function runTurn(key: string, prompt: string): Promise<string> {
  const session = await getSession(key);
  const settings = getSettings();

  return enqueue(key, async () => {
    let text = '';
    const done = session.prompt(prompt);
    const timer = setTimeout(() => {
      log('warn', `[acp] turn timeout for ${key}, cancelling`);
      acpCtx
        ?.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
        .catch(() => undefined);
    }, config.bot.turnTimeoutMs);

    try {
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === 'stop') break;

        const update = message.update;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          text += update.content.text;
        } else if (update.sessionUpdate === 'tool_call') {
          toolCalls.set(update.toolCallId, {
            title: update.title,
            kind: String(update.kind ?? 'other'),
          });
          log('info', `[tool] ${update.title}`);
        }
      }
      await done;
    } finally {
      clearTimeout(timer);
    }

    status.turns += 1;
    status.lastError = '';
    void settings;
    return text.trim();
  });
}

const SAFE_KINDS = new Set(['read', 'search', 'fetch', 'think', 'edit', 'move']);

async function decidePermission(params: {
  toolCall: { toolCallId: string };
  options: Array<{ optionId: string; kind: string }>;
}): Promise<{ outcome: { outcome: 'selected'; optionId: string } }> {
  const call = toolCalls.get(params.toolCall.toolCallId);
  const kind = call?.kind;
  let allowed = false;

  if (kind === undefined) {
    // 审批请求只带 toolCallId；类型缺失时无法判断风险，默认拒绝。
    log('warn', `[approval] unknown tool call ${params.toolCall.toolCallId} -> reject`);
  } else if (kind === 'execute') {
    allowed = getSettings().approval.allowExec || (await askAdmin(`要执行命令：${call?.title ?? ''}`));
  } else if (SAFE_KINDS.has(kind)) {
    allowed = true;
  } else {
    log('warn', `[approval] denied kind=${kind} ${call?.title ?? ''}`);
  }

  const option =
    params.options.find((item) => item.kind === (allowed ? 'allow_once' : 'reject_once')) ??
    params.options[0];

  log('info', `[approval] ${kind ?? 'unknown'} ${call?.title ?? ''} -> ${allowed ? 'allow' : 'reject'}`);
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/** 把审批请求转到管理员私聊；超时或没有管理员就拒绝。 */
function askAdmin(title: string): Promise<boolean> {
  const settings = getSettings();
  if (!settings.approval.adminQq) return Promise.resolve(false);

  const id = Math.random().toString(36).slice(2, 8);
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(id, resolve);
    void api
      .sendPrivate(
        settings.approval.adminQq,
        `【授权请求 #${id}】\n${title}\n\n回复 y 允许 / n 拒绝`,
      )
      .catch(() => undefined);

    setTimeout(() => {
      if (pendingApprovals.delete(id)) resolve(false);
    }, settings.approval.timeoutMs);
  });
}

function handleAdminReply(event: MessageEvent, text: string): boolean {
  const adminQq = getSettings().approval.adminQq;
  if (event.message_type !== 'private' || event.user_id !== adminQq) return false;
  if (pendingApprovals.size === 0) return false;

  const match = /^(y|n|允许|拒绝|好|不)/i.exec(text.trim());
  if (!match) return false;

  const approved = /^(y|允许|好)/i.test(match[1]);
  const [id, resolve] = pendingApprovals.entries().next().value as [
    string,
    (ok: boolean) => void,
  ];
  pendingApprovals.delete(id);
  resolve(approved);
  void api
    .sendPrivate(event.user_id, approved ? `已允许 #${id}` : `已拒绝 #${id}`)
    .catch(() => undefined);
  return true;
}

function shouldReply(event: MessageEvent, text: string): { ok: boolean; body: string } {
  const settings = getSettings();
  if (event.message_type === 'private') {
    return { ok: settings.chat.privateAutoReply, body: text };
  }

  const mentioned = event.message.some(
    (segment) => segment.type === 'at' && Number(segment.data.qq) === selfId,
  );
  if (mentioned) {
    return { ok: true, body: segmentsToText(stripMention(event.message, selfId)) };
  }
  const prefix = settings.chat.group.prefix;
  if (prefix && text.startsWith(prefix)) {
    return { ok: true, body: text.slice(prefix.length).trim() };
  }
  return { ok: false, body: text };
}

function buildPrompt(event: MessageEvent, body: string): string {
  const sender = event.sender.card || event.sender.nickname;
  if (event.message_type === 'group') {
    const lines = getSettings().chat.group.contextLines;
    const history = (groupHistory.get(event.group_id ?? 0) ?? [])
      .slice(-lines)
      .join('\n');
    return [
      `【QQ群 ${event.group_id}】`,
      '最近的群聊：',
      history || '(暂无)',
      '',
      `${sender}（QQ ${event.user_id}）对你说：`,
      body,
    ].join('\n');
  }
  return `【QQ私聊】${sender}（QQ ${event.user_id}）对你说：\n${body}`;
}

function remember(event: MessageEvent, text: string): void {
  if (event.message_type !== 'group' || !event.group_id) return;
  const list = groupHistory.get(event.group_id) ?? [];
  const sender = event.sender.card || event.sender.nickname;
  list.push(`${sender}: ${text}`);
  while (list.length > 20) list.shift();
  groupHistory.set(event.group_id, list);
}

function splitForQq(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const breakAt = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('；'),
    );
    const cut = breakAt > max * 0.5 ? breakAt + 1 : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function reply(event: MessageEvent, text: string): Promise<void> {
  const delay = getSettings().chat.delay;
  const chunks = splitForQq(text, delay.chunkSize);
  for (const [index, chunk] of chunks.entries()) {
    await sleep(index === 0 ? rand(delay.minMs, delay.maxMs) : rand(350, 900));
    if (event.message_type === 'group' && event.group_id) {
      await api.sendGroup(event.group_id, chunk);
    } else {
      await api.sendPrivate(event.user_id, chunk);
    }
    status.messagesOut += 1;
  }
}

async function onMessage(event: MessageEvent): Promise<void> {
  selfId ||= event.self_id;
  if (event.self_id && event.user_id === event.self_id) return;
  if (seen.has(event.message_id)) return;
  seen.add(event.message_id);
  if (seen.size > 1000) seen.clear();

  const text = segmentsToText(event.message);
  if (!text) return;

  status.messagesIn += 1;

  if (handleAdminReply(event, text)) return;

  remember(event, text);

  const trigger = shouldReply(event, text);
  if (!trigger.ok || !trigger.body) return;

  const key = keyOf(event);
  const now = Date.now();
  if (event.message_type === 'group') {
    const cooldown = getSettings().chat.group.cooldownMs;
    const last = lastGroupReply.get(event.group_id ?? 0) ?? 0;
    if (now - last < cooldown) return;
    lastGroupReply.set(event.group_id ?? 0, now);
  }

  void api.markRead(event.message_id).catch(() => undefined);
  log('info', `[msg] ${key} <- ${trigger.body.slice(0, 60)}`);

  try {
    const answer = await runTurn(key, buildPrompt(event, trigger.body));
    if (answer) {
      log('info', `[msg] ${key} -> ${answer.slice(0, 60)}`);
      await reply(event, answer);
    }
  } catch (error) {
    status.lastError = String(error);
    log('error', `[turn] ${key} failed: ${String(error)}`);
    if (event.message_type === 'private') {
      await api
        .sendPrivate(event.user_id, '（我这边刚刚走神了，稍后再试一次？）')
        .catch(() => undefined);
    }
  }
}

function spawnDsh(): ReturnType<typeof spawn> {
  // 不继承当前桌面进程的 DSH_*（尤其 DSH_PROFILE=desktop、DSH_SESSION_ID）。
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DSH_')) env[key] = value;
  }
  if (config.dsh.home) env.DSH_HOME = config.dsh.home;

  if (process.platform === 'win32') {
    // dsh.cmd 路径含空格：cmd /s /c 用外层引号包住整条命令，并关闭 Node 的引号转义。
    const command = `""${config.dsh.bin}" --profile ${config.dsh.profile}"`;
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd: config.dsh.workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(config.dsh.bin, ['--profile', config.dsh.profile], {
    cwd: config.dsh.workspace,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function startBridge(): void {
  const child = spawnDsh();

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[dsh] ${chunk.toString()}`);
  });
  child.on('exit', (code) => {
    status.acpConnected = false;
    log('error', `[acp] dsh exited with ${code}`);
    process.exitCode = code ?? 1;
  });

  if (!child.stdin || !child.stdout) throw new Error('无法连接 dsh 的 stdin/stdout');
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

  const app = acp
    .client({ name: 'dsh-qq-bridge' })
    .onRequest(acp.methods.client.session.requestPermission, async (context) => {
      return decidePermission(context.params as never);
    });

  void app
    .connectWith(stream, async (context) => {
      acpCtx = context;
      const init = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      status.acpConnected = true;
      log('info', `[acp] connected to ${init.agentInfo?.name ?? 'agent'} (protocol ${init.protocolVersion})`);
      readyResolve?.();

      await new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
      });
    })
    .catch((error: unknown) => {
      status.acpConnected = false;
      status.lastError = String(error);
      log('error', `[acp] connection failed: ${String(error)}`);
      process.exitCode = 1;
    });
}

async function startAdminServer(): Promise<void> {
  try {
    admin = startAdmin({
      getSettings: () => getSettings(),
      saveSettings: (input) => saveSettings(input),
      getPersona: async () => {
        try {
          return await readFile(personaPath, 'utf8');
        } catch {
          return '';
        }
      },
      savePersona: async (content) => {
        await writeFile(personaPath, content, 'utf8');
      },
      getSessions: () => store.list(),
      deleteSession: (key) => {
        store.delete(key);
        sessions.get(key)?.dispose();
        sessions.delete(key);
        status.sessions = sessions.size;
        log('info', `[admin] session ${key} removed`);
      },
      testSend: async (text) => {
        const target = getSettings().approval.adminQq;
        if (!target) throw new Error('请先在配置里填写管理员 QQ');
        return api.sendPrivate(target, text);
      },
      getLoginInfo: () => api.call('get_login_info'),
    });
  } catch (error) {
    log('error', `[admin] 启动失败: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  await loadSettings();
  await store.load();
  watchSettings();

  startBridge();
  await ready;

  const ws = new OneBotWs({
    url: config.onebot.wsUrl,
    token: config.onebot.token,
    onEvent: (event) => {
      void onMessage(event);
    },
    onState: (connected) => {
      status.wsConnected = connected;
    },
    onLog: (message) => log('info', message),
  });
  ws.start();

  void api
    .call<{ user_id: number; nickname: string }>('get_login_info')
    .then((info) => {
      status.qqOnline = true;
      status.selfId = info.user_id;
      status.nickname = info.nickname;
    })
    .catch((error) => {
      status.qqOnline = false;
      log('warn', `[onebot] get_login_info failed: ${String(error)}`);
    });

  await startAdminServer();

  const shutdown = (): void => {
    log('info', '[bridge] shutting down');
    ws.stop();
    void admin?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('info', `[bridge] ready; ${sessions.size} session(s) restored from store`);
}

export type { BotSettings };
void main();
