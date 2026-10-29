import {randomUUID} from 'node:crypto';
import {apply} from '../../dist/security/dsh-policy.js';
export function installFixturePolicy(){
  const keys=['BOT_MODEL_BUDGET_URL','BOT_MODEL_BUDGET_TOKEN'],saved=keys.map(key=>process.env[key]);
  try{if(process.env.FAKE_OMIT_BUDGET_POLICY==='1')for(const key of keys)delete process.env[key];apply({tools:{guard(){}},on(){}});}
  finally{keys.forEach((key,index)=>{if(saved[index]!==undefined)process.env[key]=saved[index];else delete process.env[key];});}
}
export async function beginFixtureRequest(sessionId,prompt){
  if(!process.env.BOT_MODEL_BUDGET_URL)return async()=>{};
  const call=async input=>{const response=await fetch(process.env.BOT_MODEL_BUDGET_URL,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.BOT_MODEL_BUDGET_TOKEN},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});const body=await response.json();if(!response.ok)throw new Error(body.error);return body.data;};
  const limits=await call({op:'limits',sessionId}),id=randomUUID();await call({op:'reserve',sessionId,id,kind:'conversation',provider:'fixture',model:'fixture-model',bytes:Buffer.byteLength(JSON.stringify(prompt)),maxOutputTokens:Math.min(1024,limits.maxOutputTokens)});
  return ()=>call({op:'finish',id,outcome:'completed',usage:{inputTokens:null,outputTokens:null}});
}
