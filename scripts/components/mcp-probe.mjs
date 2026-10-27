import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';

// 使用组件实际携带的客户端验证项目工具服务，只列出工具，不执行 QQ 或模型动作。
const [directory,root]=process.argv.slice(2);
if(!directory||!root)throw new Error('缺少 MCP 兼容性检查路径');
const require=createRequire(join(resolve(directory),'package.json'));
const {Client}=require('@modelcontextprotocol/client');
const {StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
const transport=new StdioClientTransport({command:process.execPath,args:[join(resolve(root),'dist/mcp-qq.js')],env:{...process.env,BOT_QQ_TOOLS:'["qq_send_message"]'},stderr:'pipe'});
const client=new Client({name:'component-compatibility',version:'1.0.0'},{capabilities:{}});
try {
  const connected=client.connect(transport);transport.stderr?.resume();await connected;
  const result=await client.listTools();
  if(result.tools.length!==1||result.tools[0].name!=='qq_send_message'||result.tools[0].inputSchema.type!=='object')throw new Error('MCP 工具兼容性检查失败');
  console.log('MCP tool discovery passed without model or QQ actions.');
}finally {await client.close();}
