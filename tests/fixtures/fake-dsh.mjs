import { createInterface } from 'node:readline';

let nextSession = 0;
const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  if (method === 'initialize') {
    respond(id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'test-agent', version: '1' } });
  } else if (method === 'session/new') {
    respond(id, { sessionId: `test-session-${++nextSession}` });
  } else if (method === 'session/resume') {
    respond(id, {});
  } else if (method === 'session/prompt') {
    const text = params.prompt.map((block) => block.text ?? '').join('');
    if (text.includes('测试超时')) return;
    if (text.includes('测试崩溃')) { process.exit(3); }
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    respond(id, { stopReason: 'end_turn' });
  }
});
lines.on('close', () => process.exit(0));
