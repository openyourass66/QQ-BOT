// 受控模型输出：验证工具流程与持久化，不评估真实视觉识别准确率。
export const mockStickerAnalysis = {
  description:'测试图片中的表情',image_text:'',meaning:'轻松地表示赞同',emotions:['开心'],
  usage:['轻松聊天时表达赞同'],avoid:['严肃求助或安慰时不要敷衍'],tags:['赞同','开心'],confidence:'high',
};
export async function completeCollection(result,args,submit) {
  if(result.status!=='needs_analysis')return result;
  return submit({...args,analysis_token:result.analysis_token,analysis:structuredClone(mockStickerAnalysis)});
}
