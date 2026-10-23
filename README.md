# QQ-BOT

基于 DSH（ACP 模式）的 AI QQ 机器人桥接。

```
QQ ←→ NapCat(OneBot 11) ←→ bridge ←→ dsh --profile acp
                                    └── MCP: qq 动作 / 浏览器
```

## 目录

```
QQ-BOT\
├─ src\bridge.ts       桥接主程序：OneBot 事件、会话映射、审批、分片
├─ src\mcp-qq.ts       QQ 动作 MCP 服务（发消息、改资料、空间、点赞）
├─ src\onebot.ts       OneBot HTTP / WebSocket 客户端
├─ src\store.ts        QQ 会话 → DSH 会话 映射
├─ src\config.ts       环境变量
├─ src\settings.ts     动态配置、校验与热加载
├─ src\admin.ts        本地管理 API
├─ src\runtime.ts      会话队列与超时控制
├─ src\permissions.ts  审批选项与回复解析
├─ bot-workspace\      机器人工作区（AGENTS.md、memory）
├─ data\               会话映射
└─ mock-onebot.mjs     假 OneBot 服务端，用于不接 QQ 的联调
```

## 快速开始（不接 QQ，先验证链路）

```powershell
cd D:\Project\software\QQ-BOT
npm install
npm run build

# 终端 A：假 OneBot
npm run mock

# 终端 B：桥接（连假服务端）
node --env-file=.env.test dist/bridge.js
```

看到 mock 打印 `[mock] REPLY:` 就说明 `消息 → DSH → 回复` 通了。

首次运行会在 `~\.dsh\profiles\acp` 创建 profile，并使用桌面端已保存的
DeepSeek 登录态；也可以在 `~\.dsh\.env` 里写 `DEEPSEEK_API_KEY`。

## 接入真 QQ

1. 安装 NapCat（Windows 一键包），登录小号；
2. NapCat 网络配置：HTTP `127.0.0.1:3000`、WS `127.0.0.1:3001`，设置 token；
3. 复制 `.env.example` 为 `.env`，填 `ONEBOT_TOKEN`、`BOT_SELF_ID`、`ADMIN_QQ`；
4. 给 acp profile 挂 MCP（见方案文档 §8）：
   ```yaml
   - insert:
       - id: mcp-qq
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: qq
           transport: stdio
           command: node
           args: ['D:\Project\software\QQ-BOT\dist\mcp-qq.js']
           env:
             ONEBOT_HTTP_URL: 'http://127.0.0.1:3000'
             ONEBOT_TOKEN: '你的 token'
   ```
5. `npm start`

## 配置与管理

需要 Node.js 22 或以上版本。`npm start` 运行已有构建产物，修改源码后先执行 `npm run build`。

首次启动会创建 `bot.config.json`（可通过 `BOT_SETTINGS_FILE` 改路径）。文件中的显式值优先，缺失字段从 `.env` 的对应配置或默认值补齐；已有文件中的值不会因修改 `.env` 自动改变。配置保存后热更新，支持编辑器通过原子替换保存文件。无效配置会报错，原文件保留。

本地管理 API 默认位于 `http://127.0.0.1:6080`，可通过 `ADMIN_UI_PORT` 修改端口，设置 `ADMIN_UI_TOKEN` 后请求需携带 `x-admin-token`。接口包括 `/api/status`、`/api/settings`、`/api/persona`、`/api/logs`、`/api/sessions`、`/api/login-info` 和 `/api/test`。仓库暂未提供管理页面，访问首页需要自行提供 `public/index.html`。

`requireMention=false` 会允许群消息无需 @ 或前缀直接触发；`contextLines=0` 关闭附加的最近群聊摘要，不清除 Agent 已有会话上下文。

主动聊天、空间确认与每日额度、浏览额度等字段仍为预留配置，目前没有完整的执行约束。QQ MCP 工具尚未接入这些开关，不能依靠设置它们限制工具调用。

## 审批

- 读、搜索、fetch：自动允许；
- 编辑、移动文件：转管理员审批；当前未实现可靠的工作区路径校验，因此不自动允许；
- 执行命令：默认转管理员审批，`allowExec=true` 时自动允许；
- 管理员回复 `y 编号` 放行、`n 编号` 拒绝；仅有一项待审批时也可直接回复 `y` / `n`；
- 删除、类型未知：拒绝。

没有管理员、审批超时、通知发送失败、轮次取消或缺少匹配审批选项时拒绝或取消审批。

## 故障处理与测试

同一会话的模型生成和回复发送串行执行。轮次超时后取消请求、丢弃异常会话，后续消息创建新会话；OneBot HTTP 请求最多等待 15 秒。DSH 初始化最多等待 30 秒，DSH 异常退出会关闭桥接并以非零状态退出，需要手动或由进程管理器重启。退出时尝试保存配置和会话映射、关闭连接并清理 DSH 子进程。

```powershell
npm run typecheck
npm test
```

测试使用临时目录和假的 ACP / OneBot 服务，验证消息顺序、超时恢复、群上下文、审批、持久化及配置热更新，不连接真实 QQ 或调用模型。
