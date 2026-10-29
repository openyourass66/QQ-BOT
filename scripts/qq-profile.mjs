import {resolve} from 'node:path';

/** 为固定版本公开的原生入口提供实例目录；不改写第三方二进制或系统 QQ 设置。 */
export function isolateQQWrapper(exports,profilePath) {
  const original=exports.NodeQQNTWrapperUtil;
  const descriptor=Object.getOwnPropertyDescriptor(exports,'NodeQQNTWrapperUtil');
  if(typeof original!=='function' || typeof original.getNTUserDataInfoConfig!=='function' || !descriptor?.writable)throw new Error('QQ 原生入口不支持当前实例隔离适配，已停止启动');
  const facade=function(...args){return Reflect.construct(original,args,new.target||original);};
  Object.setPrototypeOf(facade,original);
  for(const [name,entry] of Object.entries(Object.getOwnPropertyDescriptors(original))) {
    if(typeof entry.value==='function'&&name!=='getNTUserDataInfoConfig')Object.defineProperty(facade,name,{value:entry.value.bind(original),enumerable:entry.enumerable});
  }
  Object.defineProperty(facade,'getNTUserDataInfoConfig',{value:(...args)=>{if(args.length)throw new Error('QQ 资料目录接口不接受参数');return resolve(profilePath);}});
  exports.NodeQQNTWrapperUtil=facade;
  return facade;
}

export function installQQProfileIsolation(wrapperPath,profilePath,target=process) {
  const original=target.dlopen;
  const canonical=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
  const wrapper=canonical(wrapperPath);
  const hook=function(module,path,...args) {
    const result=original.call(this,module,path,...args);
    if(canonical(path)===wrapper)isolateQQWrapper(module.exports,profilePath);
    return result;
  };
  target.dlopen=hook;
  return ()=>{if(target.dlopen===hook)target.dlopen=original;};
}
