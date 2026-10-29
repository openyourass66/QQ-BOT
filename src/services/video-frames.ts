import {spawn} from 'node:child_process';

export const VIDEO_LIMITS={frames:12,dimension:640,frameBytes:2*1024*1024,timeout:45000};
const signature=Buffer.from([137,80,78,71,13,10,26,10]);

/** Read complete PNG records from image2pipe without decoding image pixels in the host. */
export function videoPngFrames(buffer:Buffer,count:number):Buffer[]{
  if(!Number.isSafeInteger(count)||count<1||count>VIDEO_LIMITS.frames||buffer.length>count*VIDEO_LIMITS.frameBytes)throw new Error('视频画面数量或大小超出上限');
  const frames:Buffer[]=[];let offset=0;
  while(offset<buffer.length){
    const start=offset;if(frames.length>=count||!buffer.subarray(offset,offset+8).equals(signature))throw new Error('视频抽帧返回无效图片');offset+=8;let header=false,data=false,ended=false,chunks=0;
    while(offset+12<=buffer.length){
      const length=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8),end=offset+12+length;
      if(++chunks>1024||end>buffer.length||end-start>VIDEO_LIMITS.frameBytes)throw new Error('视频画面不完整或超过大小上限');
      if(!header){if(type!=='IHDR'||length!==13)throw new Error('视频画面缺少有效尺寸');const width=buffer.readUInt32BE(offset+8),height=buffer.readUInt32BE(offset+12);if(!width||!height||width>VIDEO_LIMITS.dimension||height>VIDEO_LIMITS.dimension)throw new Error('视频画面尺寸超出上限');header=true;}
      else if(type==='IHDR')throw new Error('视频画面包含重复尺寸');
      if(type==='IDAT')data=true;offset=end;
      if(type==='IEND'){if(length||!data)throw new Error('视频画面不完整');ended=true;break;}
    }
    if(!ended)throw new Error('视频画面不完整');frames.push(buffer.subarray(start,offset));
  }
  if(!frames.length)throw new Error('未取得视频画面');return frames;
}

export async function extractVideoFrames(executable:string,input:string,count:number,signal:AbortSignal,options:{spawn?:typeof spawn;timeout?:number}={}):Promise<Buffer[]>{
  signal.throwIfAborted();if(!Number.isSafeInteger(count)||count<1||count>VIDEO_LIMITS.frames)throw new Error('视频画面数量超出上限');
  const output=Buffer.alloc(count*VIDEO_LIMITS.frameBytes);let size=0;
  const args=['-nostdin','-hide_banner','-loglevel','error','-max_alloc','67108864','-filter_threads','1','-threads','1','-max_pixels','33554432','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,avi,mpegts,mpeg,flv,ogg,gif,asf,rm','-i',input,'-map','0:v:0','-an','-sn','-dn','-vf','fps=1/3,scale=640:640:force_original_aspect_ratio=decrease','-frames:v',String(count),'-c:v','png','-pix_fmt','rgb24','-threads','1','-f','image2pipe','pipe:1'];
  await new Promise<void>((done,reject)=>{
    const child=(options.spawn??spawn)(executable,args,{windowsHide:true,stdio:['ignore','pipe','ignore']});let failure:Error|undefined;
    const stop=(error:Error)=>{failure??=error;child.kill('SIGKILL');},abort=()=>stop(signal.reason instanceof Error?signal.reason:new Error('视频抽帧已取消'));
    const timer=setTimeout(()=>stop(new Error('视频抽帧超过时间上限')),options.timeout??VIDEO_LIMITS.timeout);timer.unref();signal.addEventListener('abort',abort,{once:true});
    child.stdout!.on('data',(chunk:Buffer)=>{if(failure)return;if(size+chunk.length>output.length){stop(new Error('视频抽帧输出超过大小上限'));return;}chunk.copy(output,size);size+=chunk.length;});
    child.stdout!.once('error',error=>stop(error));child.once('error',error=>{failure??=error;});
    child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(failure)reject(failure);else if(code!==0)reject(new Error('视频解码失败，请检查文件格式与 FFmpeg'));else done();});
    if(signal.aborted)abort();
  });
  return videoPngFrames(output.subarray(0,size),count);
}
