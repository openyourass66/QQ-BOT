import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import process from 'node:process';
import * as acp from '@agentclientprotocol/sdk';

const phase = process.argv[2];
const targetId = process.argv[3];
const CWD = 'D:\\Project\\software\\QQ-BOT\\bot-workspace';

const cmd = `""D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" --profile acp"`;
const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmd], {
  cwd: CWD,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DSH_'))),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsVerbatimArguments: true,
});
child.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const app = acp
  .client({ name: 'phase-test' })
  .onRequest(acp.methods.client.session.requestPermission, async (ctx) => ({
    outcome: { outcome: 'selected', optionId: ctx.params.options[0].optionId },
  }));

const timeout = setTimeout(() => {
  console.log('TIMEOUT');
  child.kill();
  process.exit(2);
}, 120000);

try {
  await app.connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    if (phase === 'create') {
      const s = await ctx.buildSession(CWD).start();
      console.log(`SESSION_ID=${s.sessionId}`);
      const p = await s.prompt('只回复两个字：一');
      console.log('P1=', JSON.stringify(p));
    } else {
      const resumed = await ctx.request(acp.methods.agent.session.resume, {
        sessionId: targetId,
        cwd: CWD,
        mcpServers: [],
      });
      console.log('RES=', JSON.stringify(resumed));
      const s = ctx.attachSession(resumed);
      console.log('ATTACHED_ID=', JSON.stringify(s.sessionId));
      const p = await s.prompt('只回复两个字：二');
      console.log('P2=', JSON.stringify(p));
    }
  });
} catch (error) {
  console.error('ERROR_JSON=', JSON.stringify({ message: error?.message, code: error?.code, data: error?.data }));
} finally {
  clearTimeout(timeout);
  await new Promise((r) => setTimeout(r, 1200));
  child.stdin.end();
  setTimeout(() => child.kill(), 800);
}
