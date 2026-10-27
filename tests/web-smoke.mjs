import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {initializeWebOwner} from '../server/auth.mjs';
import {createManagementServer} from '../server/app.mjs';

const candidates=[process.env.WEB_SMOKE_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
let executablePath;
for(const path of candidates)if(await access(path).then(()=>true,()=>false)){executablePath=path;break;}
if(!executablePath)throw new Error('请通过 WEB_SMOKE_BROWSER 指定本机 Chromium/Edge；测试不自动安装浏览器');
const parent=await realpath(tmpdir()),dataRoot=await mkdtemp(join(parent,'qq-web-ui-'));
const output=resolve('release/web-smoke-'+Date.now());await mkdir(output,{recursive:true});
let server,browser;
try {
  const initial=await initializeWebOwner(dataRoot);
  server=await createManagementServer({root:resolve('.'),dataRoot,port:0});
  await writeFile(join(dataRoot,'.env'),'BOT_CHAT_MODE=profile\nQQ_BOT_DEEPSEEK_API_KEY=fixture-ui-private-model-value\n');
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.origin);await page.getByRole('heading',{name:'设置机器人主人',exact:true}).waitFor();
  await page.screenshot({path:join(output,'claim-desktop.png')});
  await page.getByLabel('一次性认领码').fill(initial.token);await page.getByLabel('设置管理口令').fill('fixture-only-long-management-password');
  await page.getByRole('button',{name:'确认并进入工作台'}).click();await page.getByRole('heading',{name:'工作总览',exact:true}).waitFor();
  await page.getByText('状态通道已连接',{exact:true}).waitFor();await page.screenshot({path:join(output,'overview-desktop.png')});
  await page.getByRole('link',{name:'连接配置',exact:true}).click();await page.getByText('已配置 · 内容隐藏',{exact:true}).first().waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-ui-private-model-value'));
  await page.screenshot({path:join(output,'connection-desktop.png')});
  await page.setViewportSize({width:375,height:860});await page.getByRole('link',{name:'工作总览',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile page overflows horizontally');
  await page.screenshot({path:join(output,'overview-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'退出登录'}).click();await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await page.screenshot({path:join(output,'login-mobile.png')});
  await page.getByLabel('管理口令',{exact:true}).fill('fixture-only-long-management-password');await page.getByRole('button',{name:'登录工作台'}).click();
  await page.getByRole('heading',{name:'工作总览',exact:true}).waitFor();assert.deepEqual(errors,[]);
  console.log('PASS: owner claim, masked configuration, SSE, logout/login and mobile layout; no model or QQ calls');
  console.log('Browser smoke screenshots: '+output);
}finally {
  await browser?.close();await server?.close();
  const actual=await realpath(dataRoot),inside=relative(parent,actual);if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Test data cleanup escaped its temporary root');
  await rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
