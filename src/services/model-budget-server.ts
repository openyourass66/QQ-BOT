import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {RequestBudget} from '../agent/request-budget.js';
const usage=z.object({inputTokens:z.number().int().min(0).max(1e9).nullable(),outputTokens:z.number().int().min(0).max(1e9).nullable(),cacheReadTokens:z.number().int().min(0).max(1e9).nullable().optional(),cacheWriteTokens:z.number().int().min(0).max(1e9).nullable().optional(),totalTokens:z.number().int().min(0).max(1e9).nullable().optional()}).strict();
const schema=z.discriminatedUnion('op',[
  z.object({op:z.literal('limits'),sessionId:z.string().min(1).max(256)}).strict(),
  z.object({op:z.literal('reserve'),sessionId:z.string().min(1).max(256),id:z.string().min(8).max(128),kind:z.enum(['conversation','compaction','vision','transcription','speech','learning','search','fetch']),provider:z.string().max(256),model:z.string().max(256),bytes:z.number().int().nonnegative(),maxOutputTokens:z.number().int().nonnegative().optional()}).strict(),
  z.object({op:z.literal('finish'),id:z.string().min(8).max(128),outcome:z.enum(['completed','failed','unknown']),usage}).strict(),
]);
export async function startModelBudgetServer(budget:RequestBudget){
  const token=randomBytes(32).toString('hex'),expected=Buffer.from('Bearer '+token),active=new Set<import('node:http').IncomingMessage>();
  const server=createServer(async(req,res)=>{
    const send=(status:number,value:unknown)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
    const auth=Buffer.from(req.headers.authorization??'');if(req.headers.origin||auth.length!==expected.length||!timingSafeEqual(auth,expected)){req.resume();send(401,{error:'预算接口未授权'});return;}
    if(req.method!=='POST'||req.url!=='/budget'){req.resume();send(404,{error:'未知预算接口'});return;}
    if(active.size>=32){req.resume();send(429,{error:'预算接口繁忙'});return;}active.add(req);const timer=setTimeout(()=>req.destroy(),10000);
    try{
      const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8192){send(413,{error:'预算请求过大'});req.resume();return;}chunks.push(chunk);}
      const input=schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));let result;
      if(input.op==='limits')result=budget.limits(input.sessionId);else if(input.op==='reserve')result=await budget.reserve(input);else result=await budget.finish(input.id,input.outcome,input.usage);
      send(200,{data:result});
    }catch(error){send(error instanceof z.ZodError||error instanceof SyntaxError?400:409,{error:error instanceof z.ZodError?'预算请求格式无效':error instanceof Error?error.message:'预算请求未获准'});}
    finally{clearTimeout(timer);active.delete(req);}
  });
  server.headersTimeout=10000;server.requestTimeout=10000;server.maxConnections=64;
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);done();});});const address=server.address();if(!address||typeof address==='string')throw new Error('预算服务无法启动');
  return {url:`http://127.0.0.1:${address.port}/budget`,token,close:()=>new Promise<void>((done,reject)=>{budget.close();for(const req of active)req.destroy();server.close(error=>error?reject(error):done());server.closeAllConnections();})};
}
