import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SocialStore} from '../dist/qq/social-store.js';
import {SocialEngine} from '../dist/qq/social-engine.js';
import {validateSettings} from '../dist/core/settings.js';
import {DailyUsageStore} from '../dist/core/usage.js';

test('仓储查询按会话和复合消息编号隔离，元数据视图不复制消息历史，修改失败回滚',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-repository-'));
  try{
    const store=new SocialStore(join(root,'social.json'));await store.load();const now=Date.now();
    for(const [chat,id,at] of [['private:2',1,now-2],['private:2',2,now-1],['group:3',1,now]])await store.add({chat,id,at,user:2,name:'名称',text:`内容${id}`,segments:[],self:false,recalled:false});
    assert.equal(store.view('contacts').messages.length,0);const view=store.view('contacts');view.contacts[0].name='改动';assert.notEqual(store.contacts()[0].name,'改动');
    assert.deepEqual(store.queryMessages({chat:'private:2',limit:1,offset:1}).rows.map(m=>m.id),[1]);assert.equal(store.queryMessages({query:'名称'}).total,3);
    assert.deepEqual(store.lookupMessages([{chat:'group:3',id:1}]).map(m=>m.chat),['group:3']);assert.equal(store.latestIncoming().length,2);
    await assert.rejects(store.updateWithMessages('private:2',[1],d=>{d.messages[0].text='失败';throw new Error('回滚');}),/回滚/);assert.equal(store.message('private:2',1).text,'内容1');
    await store.updateWithMessages('private:2',[1],d=>{d.messages.find(m=>m.chat==='private:2'&&m.id===1).recalled=true;});assert.equal(store.message('private:2',1).recalled,true);
    // 业务依赖可等待的归档契约，不能依赖 JSON 实现的同步返回。
    const asynchronous=new Proxy(store,{get(target,key){const value=target[key];if(typeof value!=='function')return value;return ['messages','message','context','lookupMessages','latestIncoming','queryMessages'].includes(key)?async(...args)=>value.apply(target,args):value.bind(target);}});
    const settings=validateSettings({}),usage=new DailyUsageStore(join(root,'usage.json'));await usage.load();
    const engine=new SocialEngine(asynchronous,{capabilities:()=>({})},{},usage,()=>settings,async()=>true,()=>{},()=>{});
    const result=await engine.execute({action:'social',tool:'qq_message',args:{message_id:2}},{chat:'private:2',self:1,user:2,origin:'message',signal:new AbortController().signal,sent:0,silent:false});assert.equal(result.text,'内容2');
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
