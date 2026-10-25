import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebService, readJsonLimited } from '../dist/services/web-service.js';
import { DEFAULT_SETTINGS } from '../dist/core/settings.js';
import { turnBudget, readContextUsage, toolAvailable, clipBackground } from '../dist/agent/context-policy.js';
import { learningModel } from '../dist/agent/learning-model.js';

const signal=()=>new AbortController().signal;
const bing='<ol><li class="b_algo"><h2><a href="https://example.test/article">测试文章</a></h2><p>真实摘要</p></li></ol>';
const article='<html><head><title>测试正文</title></head><body><article><h1>测试正文</h1>'+('<p>这是用于验证正文分页与来源的长文章。页面内容需要保留，脚本不能执行。</p>'.repeat(120))+'</article><script>throw new Error("script executed")</script></body></html>';

test('静态解析容忍无效 base、保留中文与实体，不执行脚本或加载资源，拒绝超大结构',async()=>{
  const s=structuredClone(DEFAULT_SETTINGS);
  const html=article.replace('<head>','<head><base href="http://[invalid">').replace('<body>','<body><img src="http://127.0.0.1:1/private"><script>globalThis.qqParserExecuted=true</script>').replaceAll('这是','中文 &amp; 这是');
  const service=new WebService(()=>s,undefined,{},async()=>({buffer:Buffer.from(html),mime:'text/html'}));
  const result=await service.read('group:1',{url:'https://example.test/article',offset:0},turnBudget(),signal());
  assert.match(result.text,/中文 & 这是/);assert.equal(result.title,'测试正文');
  assert.equal(globalThis.qqParserExecuted,undefined);assert.doesNotMatch(result.text,/globalThis/);
  const large=new WebService(()=>s,undefined,{},async()=>({buffer:Buffer.from('<html><body>'+'<span>x</span>'.repeat(40001)+'</body></html>'),mime:'text/html'}));
  await assert.rejects(large.read('group:1',{url:'https://example.test/large',offset:0},turnBudget(),signal()),/网页结构过大/);
});

test('搜索缓存隔离会话并可刷新，磁盘恢复后沿用缓存，本轮次数不能绕过',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-web-'));let count=0;const s=structuredClone(DEFAULT_SETTINGS);s.web.provider='bing';
  const download=async()=>{count++;return {buffer:Buffer.from(bing),mime:'text/html'};};
  try{
    const service=new WebService(()=>s,root,{},download),budget=turnBudget();
    let result=await service.search('group:1','资料',false,false,budget,signal());assert.equal(result.cached,false);assert.equal(result.results[0].title,'测试文章');
    result=await service.search('group:1','资料',false,false,budget,signal());assert.equal(result.cached,true);assert.equal(count,1);
    await assert.rejects(service.search('group:1','新资料',false,false,budget,signal()),/次数/);
    await service.flush();const restart=new WebService(()=>s,root,{},download);assert.equal((await restart.search('group:1','资料',false,false,turnBudget(),signal())).cached,true);
    await restart.search('group:2','资料',false,false,turnBudget(),signal());assert.equal(count,2);
    await restart.search('group:1','资料',false,true,turnBudget(),signal());assert.equal(count,3);await restart.flush();
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});

test('网页正文分页、来源编号绑定会话，脚本不执行，关闭后不返回结果',async()=>{
  const s=structuredClone(DEFAULT_SETTINGS);s.web.provider='bing';s.web.pageChars=1000;
  const service=new WebService(()=>s,undefined,{},async url=>({buffer:Buffer.from(url.includes('bing')?bing:article),mime:'text/html'}));
  const result=await service.search('group:1','资料',false,false,turnBudget(),signal()),id=result.results[0].source_id;
  await assert.rejects(service.read('group:2',{source_id:id,offset:0},turnBudget(),signal()),/来源编号/);
  const budget=turnBudget(),first=await service.read('group:1',{source_id:id,offset:0},budget,signal());assert.equal(first.nextOffset,1000);assert.equal(first.text.length,1000);assert.doesNotMatch(first.text,/script executed/);
  const second=await service.read('group:1',{source_id:id,offset:first.nextOffset},budget,signal());assert.equal(second.offset,1000);
  s.features.browsing.enabled=false;await assert.rejects(service.read('group:1',{source_id:id,offset:0},budget,signal()),/联网已关闭/);
});

test('失败只切换配置的一个备用，网页私网访问和过大响应拒绝',async()=>{
  const http=createServer((req,res)=>{res.statusCode=503;res.end('{}');});http.listen(0,'127.0.0.1');await once(http,'listening');
  try{
    const s=structuredClone(DEFAULT_SETTINGS);s.web.fallback='bing';let calls=0;
    const service=new WebService(()=>s,undefined,{BOT_SEARCH_URL:`http://127.0.0.1:${http.address().port}`},async()=>{calls++;return {buffer:Buffer.from(bing),mime:'text/html'};});
    assert.equal((await service.search('group:1','资料',false,false,turnBudget(),signal())).provider,'bing');assert.equal(calls,1);
    const real=new WebService(()=>s);await assert.rejects(real.read('group:1',{url:'http://127.0.0.1/secret',offset:0},turnBudget(),signal()),/本机或内网/);
    await assert.rejects(readJsonLimited(new Response('x'.repeat(100)),10),/超过大小/);
  }finally{http.closeAllConnections();await new Promise(done=>http.close(done));}
});

test('并发工具共用预算，读取中关闭设置不泄漏正文，上下文统计不当作计费用量',async()=>{
  const s=structuredClone(DEFAULT_SETTINGS);s.features.browsing.maxNavigations=1;let release;
  const wait=new Promise(done=>{release=done;}),service=new WebService(()=>s,undefined,{},async()=>{await wait;return {buffer:Buffer.from(article),mime:'text/html'};});
  const budget=turnBudget(),first=service.read('group:1',{url:'https://example.test',offset:0},budget,signal());
  await assert.rejects(service.read('group:1',{url:'https://example.test',offset:0},budget,signal()),/次数/);
  s.features.browsing.enabled=false;release();await assert.rejects(first,/联网已关闭/);
  assert.deepEqual(readContextUsage({sessionUpdate:'usage_update',used:100,size:1000}),{used:100,size:1000});
  assert.equal(readContextUsage({sessionUpdate:'usage_update',used:NaN,size:0}),undefined);
  assert.equal(toolAvailable('qq_search',s),false);assert.equal(toolAvailable('qq_transcribe',s,{}),false);
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
