import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readJsonLimited } from '../dist/services/read-json.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';
import { readContextUsage, toolAvailable, clipBackground } from '../dist/agent/context-policy.js';
import { learningModel } from '../dist/agent/learning-model.js';

const signal=()=>new AbortController().signal;

test('分析响应限制按流式字节累计，超限后取消读取',async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({
    start(controller){controller.enqueue(Buffer.from('{"text":"中文'));controller.enqueue(Buffer.from('内容"}'));},
    cancel(){cancelled=true;},
  }));
  await assert.rejects(readJsonLimited(response,15),/超过大小/);assert.equal(cancelled,true);
  assert.deepEqual(await readJsonLimited(new Response('{"text":"中文"}')), {text:'中文'});
  await assert.rejects(readJsonLimited(new Response(null)),/空内容/);
});

test('上下文统计不当作计费用量，工具依赖与附加背景限制继续生效',()=>{
  assert.deepEqual(readContextUsage({sessionUpdate:'usage_update',used:100,size:1000}),{used:100,size:1000});
  assert.equal(readContextUsage({sessionUpdate:'usage_update',used:NaN,size:0}),undefined);
  assert.equal(toolAvailable('qq_transcribe',DEFAULT_SETTINGS,{}),false);
  assert.ok(clipBackground('旧记录\n新记录',4).length<=4);
});

test('分析模型只发送无工具结构化请求，独立地址不会继承其他服务的密钥',async()=>{
  const requests=[];const http=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({content:[{type:'text',text:'{"memories":[],"lexicon":[]}'}]}));});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  try{
    const base=`http://127.0.0.1:${http.address().port}`,env={BOT_CHAT_MODE:'project',QQ_BOT_DEEPSEEK_API_KEY:'fixture-project-key',BOT_CHAT_BASE_URL:base,BOT_CHAT_MODEL:'fixture'};
    const model=learningModel(env);assert.equal(model.available(),'');await model.analyze({chat:'group:1',messages:[],memories:[],revision:'x'},signal());
    assert.equal(requests.length,1);assert.equal(requests[0].tools,undefined);assert.equal(JSON.stringify(requests[0]).includes('fixture-project-key'),false);
    assert.match(learningModel({...env,BOT_LEARNING_BASE_URL:'https://other.example'}).available(),/独立密钥/);
    assert.match(learningModel({BOT_CHAT_MODE:'account'}).available(),/分析需/);
  }finally{http.closeAllConnections();await new Promise(done=>http.close(done));}
});
