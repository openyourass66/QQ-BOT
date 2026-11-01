import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {randomUUID} from 'node:crypto';
import {parseQqToolSelection, registerQqTools} from './services/qq-tools.js';

const server = new McpServer({ name: 'qq', version: '2.0.0' });
registerQqTools(server, { tools: parseQqToolSelection(process.env.BOT_QQ_TOOLS), transportInstance: randomUUID() });
await server.connect(new StdioServerTransport());
console.error('[mcp-qq] ready');
