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

## 审批

- 读、搜索、fetch：自动允许；
- 写工作区：自动允许；
- 执行命令：默认拒绝，管理员 QQ 回 `y` 放行；
- 删除、类型未知：拒绝。
