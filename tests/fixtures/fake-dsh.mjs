import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync } from 'node:fs';
import { mockStickerAnalysis } from '../helpers/sticker-review.mjs';

let nextSession = 0;
let nextGroupTurn = 0;
const sessionServers = new Map();
const sessionModels = new Map();
if (process.env.FAKE_MODEL_EVENTS) appendFileSync(process.env.FAKE_MODEL_EVENTS, JSON.stringify({ args: process.argv.slice(2) }) + '\n');
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
  } else if (method === 'session/set_config_option') {
    sessionModels.set(params.sessionId, params.value);
    if (process.env.FAKE_MODEL_EVENTS) appendFileSync(process.env.FAKE_MODEL_EVENTS, JSON.stringify(params) + '\n');
    respond(id, { configOptions: [] });
  } else if (method === 'session/prompt') {
    if (process.env.FAKE_MODEL_EVENTS && sessionModels.get(params.sessionId) !== JSON.stringify(['deepseek-official', 'test-project-model'])) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'model not applied before prompt' } }) + '\n'); return;
    }
    let text = params.prompt.map((block) => block.text ?? '').join('');
    if (process.env.FAKE_GROUP_PROMPTS) {
      appendFileSync(process.env.FAKE_GROUP_PROMPTS, JSON.stringify({ sessionId: params.sessionId, text }) + '\n');
      const current = text.split('对你说：\n').at(-1).split('\n')[0];
      if (current.includes('GROUP_TIMEOUT')) return;
      if (current.includes('GROUP_TOOL_ONLY')) {
        const server = sessionServers.get(params.sessionId).find((entry) => entry.name === 'qq');
        const client = new Client({ name: 'fake-agent', version: '1' });
        try {
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])), stderr: 'pipe' }));
          const result = await client.callTool({ name: 'qq_send_message', arguments: { target_type: 'group', target_id: Number(text.match(/【QQ群 (\d+)】/)[1]), text: '工具发出的群回答' } });
          if (result.isError) throw new Error(result.content[0].text);
        } finally { await client.close(); }
        respond(id, { stopReason: 'end_turn' }); return;
      }
      await new Promise((done) => setTimeout(done, 100));
      if (!current.includes('GROUP_EMPTY')) notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `群回答 ${++nextGroupTurn}` } },
      });
      respond(id, { stopReason: 'end_turn' }); return;
    }
    if (text.includes('测试超时')) return;
    if (text.includes('测试崩溃')) { process.exit(3); }
    if (text.includes('SOCIAL_REPLY') || text.includes('SOCIAL_SILENT') || text.includes('SOCIAL_MEMORY') || text.includes('SOCIAL_STICKER')) {
      const server = sessionServers.get(params.sessionId).find(entry => entry.name === 'qq');
      const client = new Client({ name:'social-agent',version:'1' });
      try {
        await client.connect(new StdioClientTransport({command:server.command,args:server.args,env:Object.fromEntries(server.env.map(({name,value})=>[name,value])),stderr:'pipe'}));
        let tool;
        if(text.includes('SOCIAL_REPLY')) tool={name:'qq_reply',arguments:{text:'工具回复已送出',reply_to:Number(text.match(/当前消息编号 #(-?\d+)/)[1])}};
        if(text.includes('SOCIAL_SILENT')) tool={name:'qq_finish',arguments:{reason:'这段无需回应'}};
        if(text.includes('SOCIAL_MEMORY')) tool={name:'qq_memory_append',arguments:{user_id:20001,name:'测试群友',text:'喜欢咖啡'}};
        if(text.includes('SOCIAL_STICKER')) {
          const message_id=Number(text.match(/当前消息编号 #(-?\d+)/)[1]);
          const preview=await client.callTool({name:'qq_collect_sticker',arguments:{message_id}});
          if(preview.isError)throw new Error(preview.content[0].text);
          const prepared=JSON.parse(preview.content[0].text);
          if(prepared.status!=='needs_analysis'||prepared.collected!==false||!preview.content.some(c=>c.type==='image'))throw new Error('收藏没有先返回未入库的原图分析阶段');
          if(!text.includes('SOCIAL_STICKER_PENDING')) {
            const completed=await client.callTool({name:'qq_collect_sticker',arguments:{message_id,analysis_token:prepared.analysis_token,analysis:structuredClone(mockStickerAnalysis)}});
            if(completed.isError)throw new Error(completed.content[0].text);
            const sticker=JSON.parse(completed.content[0].text);
            const sent=await client.callTool({name:'qq_send_sticker',arguments:{sticker_id:sticker.id}});if(sent.isError)throw new Error(sent.content[0].text);
          }
        } else {const result=await client.callTool(tool); if(result.isError) throw new Error(result.content[0].text);}
      } finally { await client.close(); }
      notify('session/update',{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.includes('SOCIAL_STICKER_PENDING')?'收藏成功':text.includes('SOCIAL_MEMORY')?'记住了':'重复文本不应发送'}}});
      respond(id,{stopReason:'end_turn',usage:{inputTokens:120,outputTokens:30,totalTokens:150}});return;
    }
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
    text = text.split('\n\n【QQ 工具约定】')[0];
    text = text.split('\n【当前消息编号')[0];
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    respond(id, { stopReason: 'end_turn' });
  }
});
lines.on('close', () => process.exit(0));
