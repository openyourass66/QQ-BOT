import React,{useEffect,useState} from 'react';
import {request} from './api.mjs';

const options={
  'onebot-mode':[['auto','自动检测'],['managed','由工作台管理'],['external','连接外部服务']],
  'chat-mode':[['profile','使用已有 Profile'],['project','使用项目 API Key']],
};
export function Configuration({csrf,onUnauthorized}) {
  const [config,setConfig]=useState(null),[draft,setDraft]=useState({}),[secret,setSecret]=useState(null),[clearing,setClearing]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const dirty=Object.keys(draft).length>0||Boolean(secret?.value);
  const fail=error=>{if(error.status===401)onUnauthorized();else setError(error.message);};
  const load=async(refresh=false)=>{setBusy(true);setError('');try{setConfig(await request('/api/config'));setMessage(refresh===true?'已读取最新配置。待保存的输入仍保留，请核对后保存。':'');}catch(error){fail(error);}finally{setBusy(false);}};
  useEffect(()=>{load();},[]);
  useEffect(()=>{const warn=event=>{if(dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const edit=(field,value)=>setDraft(old=>{const next={...old};if(value===field.value)delete next[field.key];else next[field.key]=value;return next;});
  const save=async event=>{
    event.preventDefault();setBusy(true);setError('');setMessage('');
    try{const result=await request('/api/config',{method:'PATCH',csrf,body:{revision:config.revision,values:draft}});setConfig(result);setDraft({});setMessage(result.restartRequired?'连接配置已保存。重启机器人后生效。':'配置没有变化。');}catch(error){fail(error);}finally{setBusy(false);}
  };
  const saveSecret=async(field,operation)=>{
    setBusy(true);setError('');setMessage('');
    try{const result=await request('/api/secrets/'+field.key,{method:'PUT',csrf,body:{revision:config.revision,operation,...(operation==='replace'?{value:secret.value}:{})}});setConfig(result);setSecret(null);setClearing('');setMessage('密钥已'+(operation==='clear'?'清除':'更新')+'，重启机器人后生效。');}catch(error){fail(error);}finally{setBusy(false);}
  };
  if(!config)return <section className="card"><p role="status">{error||'正在读取连接配置…'}</p>{error&&<button onClick={load} disabled={busy}>重新读取配置</button>}</section>;
  const basicGroups=['模型选择','账号接入方式','OneBot 连接'];
  const groups=[...new Set(config.fields.filter(field=>field.kind!=='secret').map(field=>field.group))];
  const groupSection=group=><section className="card" key={group}><h2>{group}</h2><div className="configuration edit-configuration">{config.fields.filter(field=>field.group===group&&field.kind!=='secret').map(field=><div key={field.key}>
    <label htmlFor={'config-'+field.key}>{field.label}</label><div>{field.editable?<>{options[field.kind]?<select id={'config-'+field.key} value={draft[field.key]??field.value} disabled={busy} onChange={event=>edit(field,event.target.value)}>{options[field.kind].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>:<input id={'config-'+field.key} value={draft[field.key]??field.value} disabled={busy} maxLength={4096} onChange={event=>edit(field,event.target.value)} autoComplete="off"/>}</>:<><code>{field.value||'使用默认值'}</code><span className="hint field-note">{field.redacted?'包含隐藏内容，请在本机修改。':'通过本机高级配置修改。'}</span></>}</div>
  </div>)}</div></section>;
  return <>
    <section className="card configuration-toolbar"><div><h2>连接与运行参数</h2><p>保存后重启生效。密钥单独更新；程序路径和账号权限仍在本机设置。</p></div><button onClick={()=>load(true)} disabled={busy}>重新读取配置</button></section>
    {error&&<div className="error" role="alert">{error}</div>}{message&&<div className="success-note" role="status">{message}</div>}
    <form onSubmit={save}>
      {basicGroups.filter(group=>groups.includes(group)).map(groupSection)}
      <details className="advanced-configuration"><summary>更多连接与容量设置</summary>{groups.filter(group=>!basicGroups.includes(group)).map(groupSection)}</details>
      <div className="save-bar"><span role="status">{Object.keys(draft).length?'有 '+Object.keys(draft).length+' 项待保存':'连接参数已同步'}</span><div><button type="button" disabled={busy||!Object.keys(draft).length} onClick={()=>{setDraft({});setError('');}}>放弃更改</button><button className="primary" disabled={busy||!Object.keys(draft).length}>{busy?'正在保存…':'保存连接配置'}</button></div></div>
    </form>
    <section className="card"><h2>连接密钥</h2><p>保留原值无需操作。输入内容只用于本次更新，保存后立即清空。</p><div className="secret-list">{config.fields.filter(field=>field.kind==='secret').map(field=><div key={field.key}>
      <div className="secret-heading"><div><strong>{field.label}</strong><span className={field.configured?'configured':'hint'}>{field.configured?'已配置 · 内容隐藏':'尚未配置'}</span></div><button type="button" disabled={busy} onClick={()=>{setSecret({key:field.key,value:''});setClearing('');}}>更新密钥</button></div>
      {secret?.key===field.key&&<div className="secret-editor"><label htmlFor={'secret-'+field.key}>新的{field.label}</label><input id={'secret-'+field.key} type="password" autoComplete="new-password" value={secret.value} disabled={busy} maxLength={4096} onChange={event=>setSecret({...secret,value:event.target.value})}/><div className="action-row"><button className="primary" type="button" disabled={busy||!secret.value} onClick={()=>saveSecret(field,'replace')}>保存此密钥</button><button type="button" disabled={busy} onClick={()=>{setSecret(null);setClearing('');}}>取消更新</button>{field.configured&&<button className="danger" type="button" disabled={busy} onClick={()=>setClearing(field.key)}>清除原密钥</button>}</div>{clearing===field.key&&<div className="clear-confirm" role="group" aria-label={'确认清除'+field.label}><p>清除后，对应连接可能无法使用。</p><button type="button" className="danger" disabled={busy} onClick={()=>saveSecret(field,'clear')}>确认清除{field.label}</button><button type="button" disabled={busy} onClick={()=>setClearing('')}>保留原密钥</button></div>}</div>}
    </div>)}</div></section>
  </>;
}
