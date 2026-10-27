import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { apply as applyNativePolicy } from '../../dist/security/dsh-policy.js';
applyNativePolicy({tools:{guard(){}}});
let sessions=0,turns=0;
const servers=new Map();
const record=event=>appendFileSync(process.env.INTELLIGENCE_EVENTS,JSON.stringify(event)+'\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const update=(sessionId,value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:value}})+'\n');
createInterface({input:process.stdin}).on('line',async line=>{
  const {id,method,params}=JSON.parse(line);
  if(method==='initialize')send(id,{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}},agentInfo:{name:'fixture',version:'1'}});
  else if(method==='session/new'){
    sessions++;record({kind:'new',number:sessions,servers:params.mcpServers});
    if(process.env.INTELLIGENCE_FAIL_SECOND==='1'&&sessions===2){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message:'replacement fixture failure'}})+'\n');return;}
    servers.set('intelligence-'+sessions,params.mcpServers);send(id,{sessionId:'intelligence-'+sessions});
  }else if(method==='session/resume')send(id,{});
  else if(method==='session/set_config_option')send(id,{configOptions:[]});
  else if(method==='session/prompt'){
    turns++;record({kind:'prompt',sessionId:params.sessionId,text:params.prompt.map(b=>b.text??'').join('')});
    if(turns===1&&process.env.INTELLIGENCE_TEST_TOOLS==='1'){
      const server=servers.get(params.sessionId)[0],client=new Client({name:'intelligence-fixture',version:'1'});
      try{
        await client.connect(new StdioClientTransport({command:server.command,args:server.args,env:Object.fromEntries(server.env.map(e=>[e.name,e.value])),stderr:'pipe'}));
        const first=await client.callTool({name:'qq_recent_messages',arguments:{}}),second=await client.callTool({name:'qq_recent_messages',arguments:{}}),third=await client.callTool({name:'qq_recent_messages',arguments:{}});
        record({kind:'tools',first:Boolean(first.isError),second:Boolean(second.isError),third:Boolean(third.isError),reason:third.content[0]?.text});
      }finally{await client.close();}
    }
    update(params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'已处理测试消息 '+turns}});
    update(params.sessionId,{sessionUpdate:'usage_update',used:90,size:100});
    send(id,{stopReason:'end_turn'});
  }
});
