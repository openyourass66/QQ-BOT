import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let nextSession = 0;
const sessionServers = new Map();
const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  if (method === 'initialize') {
    respond(id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'test-agent', version: '1' } });
  } else if (method === 'session/new') {
    const sessionId = `test-session-${++nextSession}`;
    sessionServers.set(sessionId, params.mcpServers);
    respond(id, { sessionId });
  } else if (method === 'session/resume') {
    sessionServers.set(params.sessionId, params.mcpServers);
    respond(id, {});
  } else if (method === 'session/prompt') {
    let text = params.prompt.map((block) => block.text ?? '').join('');
    if (text.includes('测试超时')) return;
    if (text.includes('测试崩溃')) { process.exit(3); }
    if (text.includes('MCP点赞') || text.includes('MCP空间')) {
      const qzone = text.includes('MCP空间');
      const server = sessionServers.get(params.sessionId)?.find((entry) => entry.name === 'qq');
      if (!server) throw new Error('ACP 未传入 QQ MCP');
      const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
      if (!env.BOT_ACTION_TOKEN || !env.BOT_ACTION_URL) throw new Error('ACP 未显式传入动作接口凭据');
      const client = new Client({ name: 'fake-agent', version: '1' });
      try {
        await client.connect(new StdioClientTransport({
          command: server.command, args: server.args, env, stderr: 'pipe',
        }));
        const result = await client.callTool(qzone
          ? { name: 'qq_qzone_post', arguments: { text: '审批正文', images: ['https://example.test/picture.png'] } }
          : { name: 'qq_like', arguments: { user_id: 12345 } });
        text = result.isError ? `MCP拒绝:${result.content[0].text}` : qzone ? 'MCP空间成功' : 'MCP调用成功';
      } finally { await client.close(); }
    }
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    respond(id, { stopReason: 'end_turn' });
  }
});
lines.on('close', () => process.exit(0));
