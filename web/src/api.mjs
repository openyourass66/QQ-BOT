export async function request(path,{body,csrf,...options}={}) {
  const response=await fetch(path,{...options,credentials:'same-origin',headers:{...(body?{'content-type':'application/json'}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});
  let value;try{value=await response.json();}catch{throw new Error('服务返回了无法读取的内容，请稍后重试。');}
  if(!response.ok){const error=new Error(value.error||'操作未完成，请重试。');error.status=response.status;throw error;}return value;
}
