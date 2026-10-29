import {isAbsolute,join} from 'node:path';
import {installQQProfileIsolation} from './qq-profile.mjs';

// 由受管启动器的 --import 传给每代登录 Worker，在加载原生库前安装隔离。
const dataRoot=process.env.BOT_DATA_DIR,wrapper=process.env.NAPCAT_WRAPPER_PATH;
if(!dataRoot||!isAbsolute(dataRoot)||!wrapper||!isAbsolute(wrapper))throw new Error('QQ 登录进程缺少绝对路径的实例配置，已停止启动');
installQQProfileIsolation(wrapper,join(dataRoot,'napcat/qq-profile'));
