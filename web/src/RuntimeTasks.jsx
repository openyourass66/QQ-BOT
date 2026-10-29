import React,{useEffect,useState} from 'react';
import {request} from './api.mjs';
const labels={start:'启动机器人',stop:'停止机器人',restartBridge:'重连模型',component:'准备组件'};
const phases={queued:'等待执行',running:'正在执行',downloading:'正在下载',copying:'正在复制',extracting:'正在解压',installing:'正在安装',checking:'正在检查',ready:'组件已就绪',succeeded:'已完成',failed:'未完成',cancelled:'已取消'};
const pending=job=>['queued','running'].includes(job.state);
const mergeJob=(old,job)=>{const current=old.find(item=>item.id===job.id);return current&&current.version>job.version?old:[job,...old.filter(item=>item.id!==job.id)].slice(0,64);};
export function RuntimeTasks({csrf,runtime,capabilities,latestJob,sync,onUnauthorized}) {
  const [jobs,setJobs]=useState([]),[error,setError]=useState(''),[sending,setSending]=useState(false);
  const fail=error=>{if(error.status===401)onUnauthorized();else setError(error.message);};
  const load=async()=>{try{const result=await request('/api/jobs');setJobs(old=>result.jobs.reduce(mergeJob,old));}catch(error){fail(error);}};
  useEffect(()=>{load();},[sync]);
  useEffect(()=>{if(latestJob)setJobs(old=>mergeJob(old,latestJob));},[latestJob]);
  const submit=async(kind,component)=>{
    setSending(true);setError('');
    try{const result=await request(component?'/api/components/'+component+'/prepare':'/api/runtime/'+kind,{method:'POST',csrf,body:{idempotencyKey:crypto.randomUUID()}});setJobs(old=>mergeJob(old,result.job));}catch(error){fail(error);}finally{setSending(false);}
  };
  const cancel=async job=>{setSending(true);try{const result=await request('/api/jobs/'+job.id+'/cancel',{method:'POST',csrf,body:{}});setJobs(old=>mergeJob(old,result.job));}catch(error){fail(error);}finally{setSending(false);}};
  const active=jobs.find(pending),blocked=sending||Boolean(active),latest=[...jobs].sort((a,b)=>b.createdAt-a.createdAt).slice(0,8);
  return <section className="card runtime-tasks"><div className="section-heading"><h2>运行管理</h2><span className="hint">关闭网页后，机器人继续运行</span></div>
    {error&&<div className="error" role="alert">{error}</div>}<div className="action-row"><button className="primary" disabled={blocked||runtime.bridge} onClick={()=>submit('start')}>启动机器人</button><button disabled={sending||Boolean(active&&active.kind!=='component')} onClick={()=>submit('stop')}>停止机器人</button><button disabled={blocked||!runtime.bridge} onClick={()=>submit('restartBridge')}>重连模型</button></div>
    {capabilities.components&&<details className="component-actions"><summary>准备或修复运行组件</summary><p>请先停止机器人。组件就绪后，在本机工作台确认并保存启动路径。</p><div className="action-row"><button disabled={blocked||runtime.bridge||runtime.napcat} onClick={()=>submit('component','dsh')}>准备模型组件</button><button disabled={blocked||runtime.bridge||runtime.napcat} onClick={()=>submit('component','napcat')}>准备 QQ 组件</button></div></details>}
    {latest.length>0&&<ol className="job-list" aria-label="最近管理任务">{latest.map(job=><li key={job.id}><div><strong>{labels[job.kind]}{job.component==='dsh'?' · 模型':job.component==='napcat'?' · QQ':''}</strong><span role="status">{phases[job.phase]||'状态更新中'}</span><p>{job.message}</p></div>{pending(job)&&job.kind==='component'&&<button disabled={sending} onClick={()=>cancel(job)}>取消准备</button>}</li>)}</ol>}
    <p className="hint task-note">完成启停只代表操作已执行，请继续核对 QQ、模型和桥接状态。</p>
  </section>;
}
