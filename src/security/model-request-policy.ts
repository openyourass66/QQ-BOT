import {randomUUID} from 'node:crypto';
import {readJsonLimited} from '../services/read-json.js';

type Agent={id:string;cancel?:(cause:{kind:'hook';reason:string})=>void};
type PolicyContext={on:(name:string,listener:(...args:any[])=>any)=>unknown;tools:{guard:(check:(execution:{agent?:Agent})=>string|undefined)=>unknown}};
type Limits={maxOutputTokens:number;maxResponseChars:number;maxRequestKiB:number;toolsPerTurn:number};
type Report={inputTokens:number|null;outputTokens:number|null;cacheReadTokens?:number|null;cacheWriteTokens?:number|null;totalTokens?:number|null};
function reported(value:any):Report {
  const number=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=1e9?n:null;
  const result:Report={inputTokens:number(value?.inputTokens),outputTokens:number(value?.outputTokens)};for(const key of ['cacheReadTokens','cacheWriteTokens','totalTokens'] as const)if(value?.[key]!==undefined)result[key]=number(value[key]);return result;
}
export function attachModelRequestPolicy(ctx:PolicyContext,endpoint:string,token:string):void {
  const url=new URL(endpoint);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/budget'||url.username||url.password||url.search||url.hash||!/^[a-f0-9]{64}$/.test(token)||typeof ctx.on!=='function')throw new Error('受管模型请求预算接口不可用，拒绝开放模型');
  const request=async(payload:unknown,signal?:AbortSignal):Promise<any>=>{
    const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
    const body=await readJsonLimited(response,8192) as {data?:unknown;error?:unknown};if(!response.ok)throw new Error(typeof body.error==='string'?body.error:'模型请求预算未获准');return body.data;
  };
  const agents=new Map<string,Agent>(),tools=new Map<string,{turn:number;used:number;limit:number}>();
  const remember=(agent:Agent)=>{agents.set(agent.id,agent);if(agents.size>256){const oldest=agents.keys().next().value!;agents.delete(oldest);tools.delete(oldest);}};
  ctx.on('agent/created',({agent}:{agent:Agent})=>remember(agent));
  ctx.on('agent/disposed',({agent}:{agent:Agent})=>{agents.delete(agent.id);tools.delete(agent.id);});
  ctx.on('agent/request',async({agent,turn,signal}:{agent:Agent;turn:number;signal:AbortSignal},next:()=>Promise<Record<string,unknown>>)=>{
    const limits=await request({op:'limits',sessionId:agent.id},signal) as Limits;if(!Number.isSafeInteger(limits?.maxOutputTokens)||!Number.isSafeInteger(limits?.toolsPerTurn))throw new Error('模型预算配置无效');
    remember(agent);const before=tools.get(agent.id);tools.set(agent.id,{turn,used:before?.turn===turn?before.used:0,limit:limits.toolsPerTurn});
    const config=await next(),configured=typeof config.maxTokens==='number'&&Number.isSafeInteger(config.maxTokens)&&config.maxTokens>0?config.maxTokens:limits.maxOutputTokens;
    return {...config,maxTokens:Math.min(configured,limits.maxOutputTokens)};
  });
  ctx.tools.guard(execution=>{
    const state=execution.agent?tools.get(execution.agent.id):undefined;if(!state)return '当前工具不属于已登记的模型轮次';if(state.used>=state.limit)return '本轮 QQ 与原生联网工具预算已用完';state.used++;return;
  });
  ctx.on('llm/stream',async function*(options:any,next:()=>AsyncIterable<any>){
    const sessionId=String(options.sessionId??''),id=randomUUID(),reservation=await request({op:'reserve',sessionId,id,kind:options.purpose==='compaction'?'compaction':'conversation',provider:String(options.provider??''),model:String(options.model??''),bytes:Buffer.byteLength(JSON.stringify({messages:options.messages,system:options.system,tools:options.tools})),maxOutputTokens:options.maxTokens},options.signal) as Limits;
    let usage:Report={inputTokens:null,outputTokens:null},outcome:'completed'|'failed'|'unknown'='unknown',chars=0;const blocks=new Map<number,number>();
    try{
      for await(const chunk of next()){
        if(chunk.type==='usage')usage=reported(chunk.usage);
        if(chunk.type==='finish')outcome=['stop','tool-calls','max-tokens'].includes(chunk.reason?.kind)?'completed':chunk.reason?.kind==='error'?'failed':'unknown';
        let added=0;
        if(['text-delta','reasoning-delta','tool-call-delta'].includes(chunk.type)){added=String(chunk.type==='tool-call-delta'?chunk.argumentsDelta??'':chunk.text??'').length;blocks.set(chunk.index,(blocks.get(chunk.index)??0)+added);}
        if(chunk.type==='block-end'){const text=chunk.block?.text??chunk.block?.arguments??'';if(typeof text==='string')added=Math.max(0,text.length-(blocks.get(chunk.index)??0));}
        chars+=added;if(chars>reservation.maxResponseChars||blocks.size>1024){agents.get(sessionId)?.cancel?.({kind:'hook',reason:'本轮模型输出超过运行上限'});throw new Error('本轮模型输出超过运行上限，已停止继续生成');}
        yield chunk;
      }
    }finally{await request({op:'finish',id,outcome,usage});}
  });
  ctx.on('tools/execute',async(execution:any,next:()=>Promise<any>)=>{
    if(!['web_search','web_fetch'].includes(execution.name))return next();
    const id=randomUUID();await request({op:'reserve',sessionId:String(execution.agent?.id??''),id,kind:execution.name==='web_search'?'search':'fetch',provider:'native-web',model:'',bytes:Buffer.byteLength(JSON.stringify(execution.arguments)),maxOutputTokens:0},execution.signal);
    let outcome:'completed'|'failed'|'unknown'='unknown';try{const result=await next();outcome=result?.isError?'failed':'completed';return result;}finally{await request({op:'finish',id,outcome,usage:{inputTokens:null,outputTokens:null}});}
  });
}
