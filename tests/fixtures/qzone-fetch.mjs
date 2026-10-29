const original=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:input);
  if(url.hostname!=='user.qzone.qq.com'&&url.hostname!=='h5.qzone.qq.com')return original(input,options);
  if(options?.method!=='GET'||options.redirect!=='error')throw new Error('空间检查只能只读请求且禁止重定向');
  return new Response(JSON.stringify({code:0,total:0,msglist:[]}));
};
