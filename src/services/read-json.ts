export async function readJsonLimited(response:Response,max=1_000_000):Promise<unknown> {
  if(!response.body)throw new Error('服务返回空内容');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>max)throw new Error('服务响应超过大小上限');chunks.push(item.value);}}
  finally {await reader.cancel().catch(()=>undefined);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
