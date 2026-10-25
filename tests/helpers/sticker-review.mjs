// 受控模型输出：验证工具流程与持久化，不评估真实视觉识别准确率。
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const mockStickerAnalysis = {
  description:'测试图片中的表情',image_text:'',meaning:'轻松地表示赞同',emotions:['开心'],
  usage:['轻松聊天时表达赞同'],avoid:['严肃求助或安慰时不要敷衍'],tags:['赞同','开心'],confidence:'high',
};
export async function completeCollection(result,args,submit) {
  if(result.status!=='needs_analysis')return result;
  return submit({...args,analysis_token:result.analysis_token,analysis:structuredClone(mockStickerAnalysis)});
}
export function fakeQqFavorites() {
  const items=[],calls=[];
  const protocol=async(action,args={})=>{
    if(!['get_login_info','fetch_custom_face_detail','add_custom_face','delete_custom_face'].includes(action))return {matched:false};
    calls.push({action,args});
    if(action==='get_login_info')return {matched:true,data:{user_id:10000,nickname:'测试账号'}};
    if(action==='fetch_custom_face_detail')return {matched:true,data:structuredClone(items)};
    if(action==='add_custom_face'){
      const md5=createHash('md5').update(await readFile(args.file)).digest('hex');
      if(!items.some(f=>f.md5===md5))items.push({resId:'qq-'+md5,emoId:items.length+1,md5,url:'',emoOriginalPath:args.file,desc:''});
      return {matched:true,data:{result:0,errMsg:''}};
    }
    const index=items.findIndex(f=>f.resId===args.res_id);if(index>=0)items.splice(index,1);
    return {matched:true,data:{result:0,errMsg:''}};
  };
  return {items,calls,protocol};
}
