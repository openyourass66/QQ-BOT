import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';

async function request(path,{body,csrf,...options}={}) {
  const response=await fetch(path,{...options,credentials:'same-origin',headers:{...(body?{'content-type':'application/json'}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});
  let value;try{value=await response.json();}catch{throw new Error('服务返回了无法读取的内容，请稍后重试。');}
  if(!response.ok){const error=new Error(value.error||'操作未完成，请重试。');error.status=response.status;throw error;}return value;
}
function Brand(){return <div className="brand"><span className="brand-mark" aria-hidden="true">鲸</span><span><strong>小鲸工作台</strong><small>WHale Workbench</small></span></div>;}
function Icon({name}) {const paths={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',connection:'M9 15l6-6 M8 17H6a4 4 0 0 1 0-8h3 M16 7h2a4 4 0 0 1 0 8h-3',events:'M3 12h4l3-7 4 14 3-7h4'};return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;}
const pages=[['overview','工作总览'],['connection','连接配置'],['events','状态事件']];
function App() {
  const [screen,setScreen]=useState('loading'),[setup,setSetup]=useState(false),[expired,setExpired]=useState(false),[csrf,setCsrf]=useState('');
  const [password,setPassword]=useState(''),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [page,setPage]=useState(pages.some(([id])=>id===location.hash.slice(1))?location.hash.slice(1):'overview');
  const [runtime,setRuntime]=useState({}),[fields,setFields]=useState([]),[events,setEvents]=useState([]),[connected,setConnected]=useState(false),[updated,setUpdated]=useState(null);
  const boot=async()=>{
    setError('');setScreen('loading');
    try{const status=await request('/api/auth/status');setSetup(status.setupRequired);setExpired(status.claimExpired);try{const session=await request('/api/session');setCsrf(session.csrf);setScreen('ready');}catch(error){if(error.status!==401)throw error;setScreen('login');}}
    catch{setError('暂时无法连接管理服务。请确认服务仍在运行，再重新连接。');setScreen('unavailable');}
  };
  useEffect(()=>{boot();const onHash=()=>setPage(pages.some(([id])=>id===location.hash.slice(1))?location.hash.slice(1):'overview');window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[]);
  const login=async event=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{const session=await request('/api/auth/'+(setup?'claim':'login'),{method:'POST',body:setup?{token,password}:{password}});setCsrf(session.csrf);setPassword('');setToken('');setScreen('ready');}
    catch(error){setError(error.message);}finally{setBusy(false);}
  };
  const logout=async()=>{setBusy(true);try{await request('/api/auth/logout',{method:'POST',csrf});setCsrf('');setFields([]);setEvents([]);setRuntime({});await boot();}catch(error){setError(error.message);}finally{setBusy(false);}};
  useEffect(()=>{
    if(screen!=='ready')return;
    let source,closed=false;
    const unauthorized=()=>{setFields([]);setEvents([]);setRuntime({});setCsrf('');boot();};
    const load=async()=>{try{const [status,config]=await Promise.all([request('/api/status'),request('/api/config')]);if(!closed){setRuntime(status.runtime);setFields(config.fields);setUpdated(new Date());}}catch(error){if(!closed){if(error.status===401)unauthorized();else setError(error.message);}}};
    const connect=()=>{
      source?.close();if(closed||document.hidden)return;load();source=new EventSource('/api/events');
      source.onopen=()=>setConnected(true);source.onerror=()=>{setConnected(false);request('/api/session').catch(error=>{if(!closed&&error.status===401)unauthorized();});};
      source.onmessage=message=>{try{const event=JSON.parse(message.data);if(closed)return;if(event.type==='snapshot')setRuntime(event.runtime);else if(event.type==='state'||event.type==='status')setRuntime(old=>({...old,...event}));setEvents(old=>[{...event,at:new Date().toLocaleTimeString('zh-CN')},...old].slice(0,50));setUpdated(new Date());}catch{setError('状态事件读取失败，请重新连接。');}};
    };
    const visible=()=>{if(document.hidden){source?.close();setConnected(false);}else connect();};connect();document.addEventListener('visibilitychange',visible);
    return()=>{closed=true;source?.close();setConnected(false);document.removeEventListener('visibilitychange',visible);};
  },[screen]);
  if(screen!=='ready')return <main className="entry"><section className="entry-card"><Brand/>
    {screen==='loading'?<div className="loading" role="status">正在连接工作台…</div>:screen==='unavailable'?<><h1>暂时无法连接</h1><p>{error}</p><button className="primary" onClick={boot}>重新连接</button></>:<>
      <span className="eyebrow">私有管理控制台</span><h1>{setup?'设置机器人主人':'欢迎回来'}</h1><p>{setup?'使用服务器初始化时的一次性认领码，设置独立的管理口令。':'登录后查看机器人的连接与运行状态。'}</p>
      {expired?<div role="alert" className="error">认领码已过期，请在服务器本机重新生成，再刷新此页面。</div>:<form onSubmit={login}>
        {setup&&<label>一次性认领码<input type="password" name="claim-token" autoComplete="one-time-code" value={token} onChange={event=>setToken(event.target.value)} required maxLength={128}/></label>}
        <div className="password-field"><label htmlFor="owner-password">{setup?'设置管理口令':'管理口令'}</label><input id="owner-password" aria-describedby="password-hint" type="password" name="password" autoComplete={setup?'new-password':'current-password'} minLength={setup?15:undefined} maxLength={1024} value={password} onChange={event=>setPassword(event.target.value)} required/><span id="password-hint" className="hint">{setup?'至少 15 个字符，支持密码管理器和粘贴。':'口令不会显示在连接配置中。'}</span></div>
        {error&&<div className="error" role="alert">{error}</div>}<button className="primary" disabled={busy}>{busy?'正在验证…':setup?'确认并进入工作台':'登录工作台'}</button>
      </form>}
    </>}<footer>仅通过本机或 SSH 隧道访问 · 个人工作空间</footer></section></main>;
  return <div className="workspace"><a className="skip" href="#main">跳到主要内容</a><aside><Brand/><div className="nav-caption">工作空间</div><nav aria-label="主要导航">{pages.map(([id,label])=><a href={'#'+id} key={id} aria-current={page===id?'page':undefined}><Icon name={id}/>{label}</a>)}</nav><div className="aside-footer"><span className={'connection-dot '+(connected?'online':'')}/>{connected?'状态通道已连接':'状态通道重连中'}</div></aside>
    <div className="content"><header><div><span className="eyebrow">个人工作空间</span><h1>{pages.find(([id])=>id===page)?.[1]}</h1><p>{page==='overview'?'连接、消息与运行状态，一目了然。':page==='connection'?'核对现有连接，密钥始终保持隐藏。':'最近的进程和连接变化。'}</p></div><button className="quiet" onClick={logout} disabled={busy}>退出登录</button></header>
      <main id="main" tabIndex={-1}>{error&&<div className="error" role="alert">{error}</div>}{!connected&&<div className="mode-note" role="status">状态通道尚未连接，当前显示上次收到的信息，正在重连。</div>}<div className="mode-note">当前为只读管理模式。配置和启停请通过本机工作台或服务器命令完成。</div>
        {page==='overview'?<><div className="status-grid">{[['QQ 连接',runtime.qqOnline,'已登录','等待登录'],['对话模型',runtime.acpConnected,'协议已连接','尚未连接'],['机器人桥接',runtime.bridge,'进程运行中','尚未启动']].map(([label,on,yes,no])=><section className="card status-card" key={label}><span className="card-label">{label}</span><div className="status-value"><span className={'connection-dot '+(on?'online':'')}/>{on?yes:no}</div><p>{label==='机器人桥接'?'进程状态与实际可聊天状态分别检查。':label==='对话模型'?'实际回复能力需要完成模型测试。':'登录后仍需检查消息通道。'}</p></section>)}</div>
          <section className="card"><div className="section-heading"><h2>消息与容量</h2><span className="hint">{updated?'更新于 '+updated.toLocaleTimeString('zh-CN'):'等待状态更新'}</span></div><div className="metrics">{[['收到消息',runtime.messagesIn],['发出消息',runtime.messagesOut],['待处理入站',runtime.pendingIngress],['超载拒绝',runtime.ingressDropped]].map(([label,count])=><div key={label}><strong>{count??0}</strong><span>{label}</span></div>)}</div></section>
          <section className="card next-step"><div><h2>准备开始聊天</h2><p>先准备组件与模型，再完成 QQ 登录。进程启动后，仍需确认消息通道和模型实际可用。</p></div><a href="#connection" className="button">查看连接配置 <span aria-hidden="true">→</span></a></section></>:page==='connection'?<>{fields.length===0?<section className="card"><p>正在读取连接配置…</p></section>:[...new Set(fields.map(field=>field.group))].map(group=><section className="card" key={group}><h2>{group}</h2><dl className="configuration">{fields.filter(field=>field.group===group).map(field=><div key={field.key}><dt>{field.label}</dt><dd>{field.kind==='secret'?<span className={field.configured?'configured':'hint'}>{field.configured?'已配置 · 内容隐藏':'尚未配置'}</span>:<code>{field.value||'使用默认值'}</code>}</dd></div>)}</dl></section>)}</>:<section className="card"><div className="section-heading"><h2>状态变化</h2><span className="hint">最多保留最近 50 条</span></div><p className="hint">聊天正文和密钥不会显示在此处。</p>{events.length===0?<div className="empty">连接后，状态变化会显示在这里。</div>:<ol className="event-list">{events.map((event,index)=><li key={index}><time>{event.at}</time><span>{event.type==='snapshot'?'已同步当前状态':event.type==='control'?'运行操作：'+event.action+(event.ok?' · 已完成':' · 未完成'):event.type==='notice'?event.message:event.type==='state'?'受管进程状态已更新':'连接与消息计数已更新'}</span></li>)}</ol>}</section>}
      </main><footer className="page-footer">小鲸工作台 · 私有控制台预览</footer></div>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
