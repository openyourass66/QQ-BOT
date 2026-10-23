import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const CWD = 'D:\\Project\\software\\QQ-BOT\\bot-workspace';
const cmd = `""D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" --profile acp"`;
const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmd], {
  cwd: CWD,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DSH_'))),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHidden: true,
  windowsVerbatimArguments: true,
});
child.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const app = acp
  .client({ name: 'resume-test' })
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

    const s1 = await ctx.buildSession(CWD).start();
    console.log('NEW id =', s1.sessionId);
    const p1 = await s1.prompt('只回复两个字：一');
    console.log('P1 =', JSON.stringify(p1));

    const resumed = await ctx.request(acp.methods.agent.session.resume, {
      sessionId: s1.sessionId,
      cwd: CWD,
      mcpServers: [],
    });
    console.log('RESUME RESPONSE =', JSON.stringify(resumed).slice(0, 800));

    const s2 = ctx.attachSession(resumed);
    console.log('S2 id =', JSON.stringify(s2.sessionId));
    const p2 = await s2.prompt('只回复两个字：二');
    console.log('P2 =', JSON.stringify(p2));
  });
} catch (error) {
  console.error('ERROR', error);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  setTimeout(() => child.kill(), 1000);
}
