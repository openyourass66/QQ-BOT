import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import { getSettings, loadSettings, watchSettings, saveSettings, flushSettings, type BotSettings } from './settings.js';
import { log, status } from './state.js';
import { startAdmin } from './admin.js';
import { ConversationQueue, QueueFullError, withTimeout } from './runtime.js';
import { RecentMessages, splitForQq } from './message-utils.js';
import { parseApprovalReply, permissionOutcome } from './permissions.js';
import { DailyUsageStore } from './usage.js';
import { QqActionPolicy } from './qq-actions.js';
import { startActionServer, type ActionServer } from './action-server.js';

const api = new OneBotHttp(config.onebot.httpUrl, config.onebot.token);
const sessionStorePath = resolve(process.env.SESSION_STORE ?? 'data/sessions.json');
const store = new SessionStore(sessionStorePath);
const usage = new DailyUsageStore(process.env.BOT_USAGE_STORE ?? resolve(dirname(sessionStorePath), 'daily-usage.json'));
const personaPath = resolve(config.dsh.workspace, 'AGENTS.md');

const sessions = new Map<string, acp.ActiveSession>();
const creating = new Map<string, Promise<acp.ActiveSession>>();
const queue = new ConversationQueue({
  maxPerKey: config.bot.queuePerConversation,
  maxTotal: config.bot.queueTotal,
  maxConcurrent: config.bot.maxConcurrentTurns,
  onChange: (pending) => { status.pendingMessages = pending; },
});
const turnSignals = new Map<string, AbortSignal>();
const sessionContexts = new Map<string, string>();
const toolCalls = new Map<string, { title: string; kind: string; signal: AbortSignal }>();
const groupHistory = new Map<number, string[]>();
const seen = new RecentMessages();
const lastBusyNotice = new Map<string, number>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const lastGroupReply = new Map<number, number>();

let selfId = config.bot.selfId;
let acpCtx: acp.ClientContext | undefined;
let admin: { close(): Promise<void>; url: string } | undefined;
let actionServer: ActionServer | undefined;
let dshChild: ReturnType<typeof spawn> | undefined;
let ws: OneBotWs | undefined;
let stopSettings: (() => void) | undefined;
let stopping = false;
let readyResolve: (() => void) | undefined;
let readyReject: ((error: Error) => void) | undefined;
const ready = new Promise<void>((done, reject) => {
  readyResolve = done;
  readyReject = reject;
});

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const rand = (min: number, max: number): number =>
  min + Math.floor(Math.random() * Math.max(1, max - min));

function keyOf(event: MessageEvent): string {
  return event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;
}

function qqMcpServers(key: string): acp.McpServer[] {
  if (!actionServer) throw new Error('动作策略服务尚未就绪');
  const context = sessionContexts.get(key) ?? randomBytes(24).toString('hex');
  sessionContexts.set(key, context);
  return [{
    name: 'qq',
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-qq.js', import.meta.url))],
    env: [
      { name: 'ONEBOT_HTTP_URL', value: config.onebot.httpUrl },
      { name: 'ONEBOT_TOKEN', value: config.onebot.token },
      { name: 'BOT_ACTION_URL', value: actionServer.url },
      { name: 'BOT_ACTION_TOKEN', value: actionServer.token },
      { name: 'BOT_ACTION_CONTEXT', value: context },
    ],
  }];
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
          mcpServers: qqMcpServers(key),
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
        session = await ctx.buildSession({ cwd: config.dsh.workspace, mcpServers: qqMcpServers(key) }).start();
        store.set(key, session.sessionId);
      }
    } else {
      session = await ctx.buildSession({ cwd: config.dsh.workspace, mcpServers: qqMcpServers(key) }).start();
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
  const session = await withTimeout(getSession(key), config.bot.turnTimeoutMs, () => {
    void shutdown(1);
  });
  const turnToolIds = new Set<string>();
  const controller = new AbortController();
  const context = sessionContexts.get(key)!;
  turnSignals.set(context, controller.signal);
  try {
    return await withTimeout((async () => {
      let text = '';
      const done = session.prompt(prompt, { cancellationSignal: controller.signal });
      // prompt 可能先于更新流失败，必须立即订阅拒绝结果。
      const updates = (async () => {
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === 'stop') break;

          const update = message.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            text += update.content.text;
          } else if (update.sessionUpdate === 'tool_call') {
            turnToolIds.add(update.toolCallId);
            toolCalls.set(update.toolCallId, {
              title: update.title,
              kind: String(update.kind ?? 'other'),
              signal: controller.signal,
            });
            log('info', `[tool] ${update.title}`);
          }
        }
      })();
      await Promise.all([done, updates]);

      status.turns += 1;
      status.lastError = '';
      return text.trim();
    })(), config.bot.turnTimeoutMs, () => {
      log('warn', `[acp] turn timeout for ${key}, cancelling`);
      controller.abort();
      void acpCtx?.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
        .catch(() => undefined);
    });
  } catch (error) {
    controller.abort();
    session.dispose();
    sessions.delete(key);
    sessionContexts.delete(key);
    store.delete(key);
    status.sessions = sessions.size;
    throw error;
  } finally {
    controller.abort();
    turnSignals.delete(context);
    for (const id of turnToolIds) toolCalls.delete(id);
  }
}

const SAFE_KINDS = new Set(['read', 'search', 'fetch', 'think']);

async function decidePermission(params: {
  toolCall: { toolCallId: string };
  options: Array<{ optionId: string; kind: string }>;
}): Promise<ReturnType<typeof permissionOutcome>> {
  const call = toolCalls.get(params.toolCall.toolCallId);
  const kind = call?.kind;
  let allowed = false;

  if (call?.signal.aborted || stopping) {
    return permissionOutcome(params.options, false);
  } else if (kind === undefined) {
    // 审批请求只带 toolCallId；类型缺失时无法判断风险，默认拒绝。
    log('warn', `[approval] unknown tool call ${params.toolCall.toolCallId} -> reject`);
  } else if (kind === 'execute') {
    allowed = getSettings().approval.allowExec || (await askAdmin(`要执行命令：${call?.title ?? ''}`, call?.signal));
  } else if (kind === 'edit' || kind === 'move') {
    allowed = await askAdmin(`要修改或移动文件：${call?.title ?? ''}`, call?.signal);
  } else if (SAFE_KINDS.has(kind)) {
    allowed = true;
  } else {
    log('warn', `[approval] denied kind=${kind} ${call?.title ?? ''}`);
  }

  log('info', `[approval] ${kind ?? 'unknown'} ${call?.title ?? ''} -> ${allowed ? 'allow' : 'reject'}`);
  return permissionOutcome(params.options, allowed);
}

/** 把审批请求转到管理员私聊；超时或没有管理员就拒绝。 */
function askAdmin(title: string, signal?: AbortSignal): Promise<boolean> {
  const settings = getSettings();
  if (!settings.approval.adminQq || signal?.aborted) return Promise.resolve(false);

  const id = randomBytes(3).toString('hex');
  return new Promise<boolean>((resolve) => {
    const finish = (approved: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      pendingApprovals.delete(id);
      resolve(approved);
    };
    const cancel = (): void => finish(false);
    const timer = setTimeout(() => finish(false), settings.approval.timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    pendingApprovals.set(id, finish);
    void api
      .sendPrivate(
        settings.approval.adminQq,
        `【授权请求 #${id}】\n${title}\n\n回复 y ${id} 允许 / n ${id} 拒绝`,
      )
      .catch(() => finish(false));
  });
}

function handleAdminReply(event: MessageEvent, text: string): boolean {
  const adminQq = getSettings().approval.adminQq;
  if (event.message_type !== 'private' || event.user_id !== adminQq) return false;
  if (pendingApprovals.size === 0) return false;

  const match = parseApprovalReply(text);
  if (!match) return false;

  const approved = match.approved;
  const id = match.id ?? (pendingApprovals.size === 1 ? pendingApprovals.keys().next().value : undefined);
  const resolve = id ? pendingApprovals.get(id) : undefined;
  if (!resolve) {
    void api.sendPrivate(event.user_id, '请带有效的授权编号回复，例如 y a1b2c3').catch(() => undefined);
    return true;
  }
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
  return { ok: !settings.chat.group.requireMention, body: text };
}

function buildPrompt(event: MessageEvent, body: string): string {
  const sender = event.sender.card || event.sender.nickname;
  if (event.message_type === 'group') {
    const lines = getSettings().chat.group.contextLines;
    const history = lines > 0
      ? (groupHistory.get(event.group_id ?? 0) ?? []).slice(-lines).join('\n')
      : '';
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
  while (list.length > 30) list.shift();
  groupHistory.set(event.group_id, list);
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
  if (stopping) return;
  selfId ||= event.self_id;
  if (event.self_id && event.user_id === event.self_id) return;
  if (seen.isDuplicate(event)) return;

  const text = segmentsToText(event.message);
  if (!text) return;

  status.messagesIn += 1;

  if (handleAdminReply(event, text)) return;

  const trigger = shouldReply(event, text);
  const prompt = trigger.ok ? buildPrompt(event, trigger.body) : '';
  remember(event, text);
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

  await queue.run(key, async () => {
    if (stopping) return;
    try {
      const answer = await runTurn(key, prompt);
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
  }).catch(async (error: unknown) => {
    if (!(error instanceof QueueFullError)) throw error;
    status.messagesDropped++;
    log('warn', `[queue] ${key} rejected; pending=${queue.size}`);
    if (event.message_type !== 'private') return;
    const lastNotice = lastBusyNotice.get(key);
    if (lastNotice !== undefined && Date.now() - lastNotice < 15_000) return;
    lastBusyNotice.set(key, Date.now());
    if (lastBusyNotice.size > 1000) lastBusyNotice.delete(lastBusyNotice.keys().next().value!);
    await api.sendPrivate(event.user_id, '（消息有点多，这条还没接上，稍后再发给我吧。）')
      .then(() => { status.messagesOut++; })
      .catch(() => undefined);
  });
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
  dshChild = child;
  child.on('error', (error) => {
    readyReject?.(error);
    if (!stopping) void shutdown(1);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[dsh] ${chunk.toString()}`);
  });
  child.on('exit', (code) => {
    status.acpConnected = false;
    acpCtx = undefined;
    readyReject?.(new Error(`DSH 已退出 (${code})`));
    if (stopping) return;
    log('error', `[acp] dsh exited with ${code}`);
    void shutdown(1);
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
      readyReject?.(error instanceof Error ? error : new Error(String(error)));
      if (!stopping) void shutdown(1);
    });
}

async function startAdminServer(): Promise<void> {
  try {
    admin = await startAdmin({
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
        if (queue.has(key)) throw new Error('会话正在处理消息，请稍后删除');
        store.delete(key);
        sessions.get(key)?.dispose();
        sessions.delete(key);
        sessionContexts.delete(key);
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
  await usage.load();
  stopSettings = watchSettings();

  const policy = new QqActionPolicy(api, usage, getSettings, askAdmin, () => {
    status.messagesOut += 1;
  });
  actionServer = await startActionServer((input, signal, conversation) => {
    if (stopping) return Promise.reject(new Error('桥接正在退出'));
    const turnSignal = conversation ? turnSignals.get(conversation) : undefined;
    if (!turnSignal) return Promise.reject(new Error('该会话没有正在执行的模型轮次'));
    return policy.execute(input, AbortSignal.any([signal, turnSignal]));
  });

  startBridge();
  await withTimeout(ready, 30_000);

  let connectionGeneration = 0;
  let heartbeatRevision = 0;
  ws = new OneBotWs({
    url: config.onebot.wsUrl,
    token: config.onebot.token,
    onEvent: (event) => {
      void onMessage(event).catch((error) => log('error', `[message] ${String(error)}`));
    },
    onState: (connected) => {
      status.wsConnected = connected;
      const generation = ++connectionGeneration;
      if (!connected) { status.qqOnline = false; return; }
      const revision = heartbeatRevision;
      void api.call<{ user_id: number; nickname: string }>('get_login_info').then((info) => {
        if (generation !== connectionGeneration || !status.wsConnected) return;
        if (!Number.isSafeInteger(info.user_id) || info.user_id <= 0 || typeof info.nickname !== 'string') {
          throw new Error('无效的登录信息');
        }
        selfId ||= info.user_id;
        status.selfId = info.user_id;
        status.nickname = info.nickname;
        if (revision === heartbeatRevision) status.qqOnline = true;
      }).catch((error) => {
        if (generation !== connectionGeneration) return;
        if (revision === heartbeatRevision) status.qqOnline = false;
        log('warn', `[onebot] get_login_info failed: ${String(error)}`);
      });
    },
    onHeartbeat: (online) => { heartbeatRevision++; status.qqOnline = online; },
    onLog: (message) => log('info', message),
  });
  ws.start();

  await startAdminServer();

  log('info', `[bridge] ready; ${store.list().length} saved session(s), resumed on demand`);
}

async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', '[bridge] shutting down');
  ws?.stop();
  stopSettings?.();
  for (const finish of pendingApprovals.values()) finish(false);
  for (const session of sessions.values()) session.dispose();
  dshChild?.stdin?.end();
  // Windows 的 cmd 启动器需要连同其 DSH 子进程一起结束。
  const stopChild = async (): Promise<void> => {
    if (!dshChild?.pid || dshChild.exitCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolveStop) => {
        const killer = spawn('taskkill', ['/pid', String(dshChild!.pid), '/t', '/f'], { windowsHide: true });
        killer.once('error', () => resolveStop());
        killer.once('exit', () => resolveStop());
      });
    } else dshChild.kill('SIGTERM');
  };
  try {
    await withTimeout(Promise.all([
      actionServer?.close(), usage.flush(), store.flush(), flushSettings(), admin?.close(), stopChild(),
    ]), 5000);
  } catch (error) {
    log('error', `[shutdown] ${String(error)}`);
    code = 1;
  }
  process.exit(code);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown();
});
process.on('disconnect', () => { void shutdown(); });
export type { BotSettings };
void main().catch((error) => {
  log('error', `[startup] ${String(error)}`);
  void shutdown(1);
});
