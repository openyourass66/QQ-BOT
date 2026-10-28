import type {OperationRecord} from '../storage/operation-types.js';

const messages=['send_private_msg','send_group_msg'];
const tools:Readonly<Record<string,readonly string[]>>=Object.freeze({
  normal_reply:messages,reminder:messages,system_notice:messages,
  qq_reply:messages,qq_send_message:messages,qq_send_image:messages,qq_send_sticker:messages,qq_speak:messages,
  qq_like:['send_like'],qq_poke:['friend_poke','group_poke'],qq_collect_sticker:['add_custom_face'],
  qq_handle_request:['set_friend_add_request','set_group_add_request'],qq_send_file:['upload_group_file','upload_private_file'],
  qq_set_profile:['set_qq_profile','set_self_longnick'],qq_set_group_card:['set_group_card'],qq_set_avatar:['set_qq_avatar'],qq_recall:['delete_msg'],
  qq_qzone_post:['send_qzone_msg'],qq_qzone_comment:['qzone_comment'],owner_sticker_collect:['add_custom_face'],owner_sticker_remove:['delete_custom_face'],
});
const mutations=new Set(Object.values(tools).flat());
const reads=new Set(['get_login_info','get_friend_list','get_group_list','get_group_member_list','get_group_member_info','get_friend_msg_history','get_group_msg_history','get_forward_msg','get_group_root_files','get_group_files_by_folder','get_group_file_url','get_private_file_url','get_image','get_record','get_video','get_cookies','fetch_custom_face_detail','download_file','mark_msg_as_read']);
export function protocolMutation(name:string):boolean{if(mutations.has(name))return true;if(reads.has(name))return false;throw new Error('协议动作未登记，不能直接执行：'+name);}
export function assertProtocolOperation(record:OperationRecord,name:string):void{if(!tools[record.tool]?.includes(name))throw new Error('当前能力不能提交这个协议动作。');}
export const registeredProtocolTools=Object.freeze(Object.keys(tools));
