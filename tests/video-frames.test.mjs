import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {extractVideoFrames,videoPngFrames,VIDEO_LIMITS} from '../dist/services/video-frames.js';
import {MediaService} from '../dist/services/media.js';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=','base64'),signal=()=>new AbortController().signal;
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'qq-video-frames-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}}
async function processor(root,body,onSpawn=()=>{}){const script=join(root,'processor.mjs');await writeFile(script,body);return (_executable,args,options)=>{const child=spawn(process.execPath,[script,...args],options);onSpawn(child,args,options);return child;};}

test('管道 PNG 按完整记录分帧，尺寸、数量、单帧字节、截断与垃圾输出均拒绝',()=>{
  assert.deepEqual(videoPngFrames(Buffer.concat([png,png]),2),[png,png]);assert.throws(()=>videoPngFrames(Buffer.concat([png,png]),1),/无效图片/);
  const huge=Buffer.from(png);huge.writeUInt32BE(641,16);assert.throws(()=>videoPngFrames(huge,1),/尺寸/);assert.throws(()=>videoPngFrames(png.subarray(0,-1),1),/不完整/);assert.throws(()=>videoPngFrames(Buffer.from('invalid'),1),/无效图片/);
  assert.throws(()=>videoPngFrames(Buffer.alloc(VIDEO_LIMITS.frameBytes+1),1),/大小/);assert.throws(()=>videoPngFrames(png,13),/数量/);assert.throws(()=>videoPngFrames(Buffer.alloc(0),1),/未取得/);
});

test('真实受控子进程输出跨块 PNG，命令限制像素、线程、尺寸、格式和帧数且不写帧文件',()=>fixture(async root=>{
  let args,options;const launch=await processor(root,`const p=Buffer.from('${png.toString('base64')}','base64');process.stdout.write(p.subarray(0,7));setTimeout(()=>process.stdout.end(Buffer.concat([p.subarray(7),p])),10);`,(_child,a,o)=>{args=a;options=o;});
  assert.deepEqual(await extractVideoFrames('fixture','input.video',2,signal(),{spawn:launch}),[png,png]);assert.equal(args.at(-1),'pipe:1');assert.equal(args[args.indexOf('-frames:v')+1],'2');assert.equal(args[args.indexOf('-max_pixels')+1],'33554432');assert.ok(args.includes('fps=1/3,scale=640:640:force_original_aspect_ratio=decrease'));assert.equal(options.windowsHide,true);assert.deepEqual(options.stdio,['ignore','pipe','ignore']);assert.deepEqual(await readdir(root),['processor.mjs']);
}));

for(const mode of ['overflow','timeout','abort','failure'])test(`抽帧 ${mode} 后等待真实子进程关闭，不返回部分画面`,()=>fixture(async root=>{
  let child,abort=new AbortController();const body=mode==='overflow'?`process.stdout.write(Buffer.alloc(${VIDEO_LIMITS.frameBytes+1}));setInterval(()=>{},1000);`:mode==='failure'?`process.stdout.write(Buffer.from('${png.toString('base64')}','base64'));process.exitCode=9;`:'setInterval(()=>{},1000);';
  const launch=await processor(root,body,c=>{child=c;if(mode==='abort')c.once('spawn',()=>abort.abort(new Error('cancelled')));});
  await assert.rejects(extractVideoFrames('fixture','input',1,abort.signal,{spawn:launch,timeout:mode==='timeout'?40:5000}),mode==='overflow'?/大小/:mode==='timeout'?/时间/:mode==='abort'?/cancelled/:/解码失败/);
  assert.ok(child.exitCode!==null||child.signalCode!==null);assert.throws(()=>process.kill(child.pid,0));
}));

test('启动失败、预先取消和无效帧数不会产生假成功',()=>fixture(async root=>{
  await assert.rejects(extractVideoFrames(join(root,'missing.exe'),'input',1,signal()),error=>error.code==='ENOENT');let spawned=false;const launch=()=>{spawned=true;throw new Error('不应启动');};const abort=new AbortController();abort.abort(new Error('already cancelled'));
  await assert.rejects(extractVideoFrames('fixture','input',1,abort.signal,{spawn:launch}),/already cancelled/);await assert.rejects(extractVideoFrames('fixture','input',13,signal(),{spawn:launch}),/数量/);assert.equal(spawned,false);
}));

test('视频处理在读取材料前占用唯一槽，失败后释放，不积压额外下载或解码',()=>fixture(async root=>{
  const previous=process.env.BOT_FFMPEG_BIN;process.env.BOT_FFMPEG_BIN='fixture';let release,entered;const ready=new Promise(done=>entered=done),gate=new Promise(done=>release=done);let reads=0;const service=new MediaService(root,()=>DEFAULT_SETTINGS.social);
  service.bytes=async()=>{reads++;entered();await gate;throw new Error('read failed');};
  try{const first=service.video('first','question',signal());await ready;await assert.rejects(service.video('second','question',signal()),/已有视频/);assert.equal(reads,1);release();await assert.rejects(first,/read failed/);await assert.rejects(service.video('third','question',signal()),/read failed/);assert.equal(reads,2);}finally{release();if(previous===undefined)delete process.env.BOT_FFMPEG_BIN;else process.env.BOT_FFMPEG_BIN=previous;}
}));

if(process.env.FFMPEG_TEST_BIN)test('真实 FFmpeg：超长纵向视频缩至双边上限，帧只存在管道中，完整媒体链路保留容量索引',()=>fixture(async root=>{
  const executable=resolve(process.env.FFMPEG_TEST_BIN),input=join(root,'portrait.avi'),media=join(root,'media'),previous=process.env.BOT_FFMPEG_BIN;process.env.BOT_FFMPEG_BIN=executable;
  const child=spawn(executable,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=80x1200:rate=1','-t','6','-c:v','mpeg4','-y',input],{windowsHide:true,stdio:'ignore'});assert.equal((await once(child,'exit'))[0],0);
  try{
    const frames=await extractVideoFrames(executable,input,2,signal());assert.equal(frames.length,2);for(const frame of frames){assert.ok(frame.readUInt32BE(16)<=640);assert.equal(frame.readUInt32BE(20),640);}
    const settings=structuredClone(DEFAULT_SETTINGS.social);settings.videoFrames=2;let seen;const service=new MediaService(media,()=>settings);service.bytes=async()=>({buffer:await (await import('node:fs/promises')).readFile(input),mime:'video/avi'});service.vision=async(images)=>{seen=images;return 'visual result';};
    assert.equal(await service.video(input,'question',signal()),'visual result');assert.equal(seen.length,2);assert.equal(seen[0].mimeType,'image/png');assert.equal((await readdir(media)).length,1);assert.ok((await readdir(media))[0].endsWith('.video'));await service.flush();
  }finally{if(previous===undefined)delete process.env.BOT_FFMPEG_BIN;else process.env.BOT_FFMPEG_BIN=previous;}
}));
