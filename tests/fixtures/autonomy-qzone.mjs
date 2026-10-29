import { appendFileSync } from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:input);
  if(!['user.qzone.qq.com','h5.qzone.qq.com'].includes(url.hostname))return original(input,options);
  if(options.method==='POST'){
    appendFileSync(process.env.FAKE_QZONE_POSTS,JSON.stringify({content:options.body.get('content'),owner:options.body.get('hostUin')})+'\n');
    return new Response('{"code":0,"commentid":"fixture-comment"}');
  }
  return new Response(JSON.stringify({code:0,total:1,msglist:[{tid:'space-fixture',uin:Number(url.searchParams.get('uin')),content:'今天看到一只很有精神的猫',created_time:Math.floor(Date.now()/1000)}]}));
};
