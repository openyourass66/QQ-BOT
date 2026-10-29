import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS} from '../dist/core/settings.js';
import {socialTools} from '../dist/qq/social-tools.js';
import {legacyTools} from '../dist/qq/legacy-tools.js';
import {toolAccess,assertToolAccess,assertTargetAccess,approvalBinding} from '../dist/security/tool-policy.js';

const settings=structuredClone(DEFAULT_SETTINGS);settings.approval.adminQq=10001;
const member={chat:'group:30001',user:20001,self:90000,origin:'message',signal:new AbortController().signal,sent:0,silent:false};

test('每个对外 QQ 工具均有明确策略，未知工具和伪造主人来源不能获得权限',()=>{
  assert.deepEqual(Object.keys(toolAccess).sort(),[...socialTools,...legacyTools].map(tool=>tool.name).sort());
  for(const context of [member,{...member,user:10001,origin:'notice'},{...member,user:10001,origin:undefined},{...member,user:10001,origin:'background'},{...member,user:10001,proactive:true}]){
    for(const name of ['qq_chats','qq_get_friend_list','qq_get_group_list','qq_send_message','qq_set_profile','qq_set_avatar','qq_handle_request','qq_qzone_feed','qq_qzone_comment','qq_qzone_post'])assert.throws(()=>assertToolAccess(context,settings,name,{confirmed:true,admin:true}),/仅机器人主人/);
    assert.throws(()=>assertToolAccess(context,settings,'unknown'),/仅机器人主人/);
  }
  assert.doesNotThrow(()=>assertToolAccess({...member,user:10001},settings,'qq_chats'));
});

test('普通会话可正常回复、查当前群和给发言者点赞，不能跨会话或冒用其它目标',()=>{
  for(const name of ['qq_reply','qq_recent_messages','qq_memory_query','qq_send_image'])assert.doesNotThrow(()=>assertToolAccess(member,settings,name));
  assert.doesNotThrow(()=>assertTargetAccess(member,settings,member.chat));
  assert.doesNotThrow(()=>assertTargetAccess(member,settings,'private:20001',true));
  assert.throws(()=>assertTargetAccess(member,settings,'private:20002',true),/跨会话/);
  assert.throws(()=>assertTargetAccess(member,settings,'group:30002'),/跨会话/);
  assert.throws(()=>assertToolAccess(member,settings,'qq_like',{user_id:10001}),/发言者/);
  assert.doesNotThrow(()=>assertToolAccess(member,settings,'qq_like',{user_id:20001}));
  assert.throws(()=>assertToolAccess(member,settings,'qq_get_group_member_list',{group_id:30002}),/当前群/);
});

test('空间自主预授权只开放任务所属能力，不能借此枚举联系人或执行账号操作',()=>{
  const context={...member,origin:'background',proactive:true,autonomous:{kind:'qzone-comment'}};
  assert.doesNotThrow(()=>assertToolAccess(context,settings,'qq_qzone_feed'));
  assert.doesNotThrow(()=>assertToolAccess(context,settings,'qq_qzone_comment'));
  for(const name of ['qq_qzone_post','qq_chats','qq_set_profile'])assert.throws(()=>assertToolAccess(context,settings,name),/仅机器人主人/);
});

test('一次确认绑定完整正文、目标、身份、最新设置与有效期，不能替换或延长',()=>{
  let now=100;const operation={tool:'qq_send_message',target:'private:20001',actor:10001,text:'允许的正文',images:['sha256:image']};
  const binding=approvalBinding(settings,operation,()=>now);
  binding.assert(settings);
  for(const patch of [{text:'另一个正文'},{target:'private:20002'},{actor:20001},{images:['sha256:other']}] )assert.throws(()=>binding.assert(settings,{...operation,...patch}),/确认已过期/);
  const changed=structuredClone(settings);changed.approval.adminQq=20001;assert.throws(()=>binding.assert(changed),/确认已过期/);
  now+=120000;assert.throws(()=>binding.assert(settings),/确认已过期/);
});
