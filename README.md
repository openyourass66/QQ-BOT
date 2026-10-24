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
├─ src\runtime.ts      会话队列与超时控制
├─ src\message-utils.ts 消息去重与文本分片
├─ src\permissions.ts  审批选项与回复解析
├─ src\qq-actions.ts   QQ 动作开关、审批与额度校验
├─ src\usage.ts        每日额度持久化（上海时区）
├─ src\action-server.ts 桥接内部动作接口
├─ src\action-client.ts MCP 动作接口客户端
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
2. NapCat 网络配置：HTTP `127.0.0.1:3000`、WS `127.0.0.1:3001`，设置 token，消息格式选择消息段数组；
3. 复制 `.env.example` 为 `.env`，填 `ONEBOT_TOKEN`、`BOT_SELF_ID`、`ADMIN_QQ`；
4. 桥接会在新建和恢复 ACP 会话时自动挂载名为 `qq` 的 MCP，并显式传入 OneBot 与内部动作接口凭据。升级前若已在 acp profile 中手动配置 `mcp-qq` / `serverName: qq`，请移除旧的重复配置；其它 MCP（如浏览器）保留原有配置；
5. `npm start`

## 配置与管理

需要 Node.js 22 或以上版本。`npm start` 运行已有构建产物，修改源码后先执行 `npm run build`。

首次启动会创建 `bot.config.json`（可通过 `BOT_SETTINGS_FILE` 改路径）。文件中的显式值优先，缺失字段从 `.env` 的对应配置或默认值补齐；已有文件中的值不会因修改 `.env` 自动改变。配置保存后热更新，支持编辑器通过原子替换保存文件。无效配置会报错，原文件保留。

### 启动与停止

先启动 NapCat 并完成 QQ 登录，再运行 `npm start`。停止机器人时在终端按 `Ctrl+C`，程序会保存会话与额度数据，并清理自己启动的 DSH 子进程。

人设直接编辑 `bot-workspace/AGENTS.md`，新建会话会读取最新人设。动态设置直接编辑 `bot.config.json`，有效修改会自动热加载。

### 可选：NapCat 独立 Node 运行环境

如果 Shell 方式的 NapCat 在加载 QQ 时崩溃，可使用 `scripts/napcat-node.mjs`。它从 `BOT_QQ_DIR` 读取 QQ 版本，将所需文件复制到 `napcat/node-runtime`，不修改系统 QQ。先解压官方 NapCat Shell 到 `napcat/shell`，并将官方 Node 运行适配库 `QQNT.dll` 放入 `napcat/node-runtime/QQNT.dll`；此适配库与系统 QQ 的同名文件用途不同。在 `.env` 中设置 `BOT_QQ_DIR`，然后在独立终端运行：

```powershell
npm run napcat
```

启动后按需扫码登录 QQ，再在另一个终端运行 `npm start`。停止桥接不会结束这个独立运行的 NapCat，需在其终端中单独停止。首次部署会复用 Shell 目录中的账号配置，后续配置以 `napcat/node-runtime/config` 为准。

`requireMention=false` 会允许群消息无需 @ 或前缀直接触发；`contextLines=0` 关闭附加的最近群聊摘要，不清除 Agent 已有会话上下文。

### 群聊对话与上下文

群友发言、机器人实际发送成功的回复及群消息工具的发送结果会加入本地群记录；按机器人账号与群号隔离。默认文件为 `SESSION_STORE` 同目录下的 `group-context.json`，可通过 `BOT_GROUP_CONTEXT_STORE` 指定路径。每群保留最近 24 小时最多 80 条、单条最多 2000 字符，总计最多 100 个群；过期条目在读取上下文和后续落盘时淘汰。重启会恢复记录。

每次模型真正开始处理时，才从群记录选取 `chat.group.contextLines` 条背景，包括前一轮刚发出的机器人回答，不把排队期间更晚到达的其他问题混入当前问题。ACP 自身的会话恢复继续保留。

- @ 机器人、叫配置名称 / QQ 昵称、使用前缀，以及引用最近记录中的机器人消息，都算直接对话；即使只有 @ 没正文，也会自然接一句。
- 直接对话不受 `cooldownMs` 静默丢弃，仍受消息队列容量限制；忙碌、模型超时或空回复时会有简短反馈，同群忙碌提示最多每 15 秒一条。
- `chat.group.followUpMs` 默认 90000：机器人回应后，同一群友在 90 秒内说“那为什么”“这个呢”等追问，不用重新 @。设为 0 可关闭；在 `bot.config.json` 中可调整。引用第三方或 @ 其他人时不自动当成追问。
- 普通旁聊仍由 `requireMention` 和冷却控制，避免插话刷屏；普通回答由桥接直接发送，不消耗 QQ 工具的主动消息额度。

OneBot 的消息段数组与 CQ 字符串格式均可识别 @ 和引用。群记录存储普通文本及媒体占位说明，不保存图片内容。

## QQ 工具额度

QQ MCP 的主动发消息、点赞和空间发布由桥接统一执行，多个会话的 MCP 子进程共享额度。普通对话回复及审批通知不计入主动消息额度。

| 配置 | 实际行为 |
| --- | --- |
| `budgets.proactiveMessagesPerDay` | MCP 主动私聊及群消息的合计每日上限，默认 5 条 |
| `chat.group.proactive.enabled` | 是否允许 MCP 主动往群里发消息，默认关闭 |
| `chat.group.proactive.perGroupPerDay` | 每个群的主动消息上限，默认 1 条，同时受全局额度约束 |
| `budgets.likesPerDay` | 点赞总次数上限，默认 20；一次调用 `times=5` 扣 5 次 |
| `features.qzone.enabled` | 是否允许发布空间，默认关闭 |
| `features.qzone.requireConfirm` | 默认开启；发布前通过管理员 QQ 审批实际正文及图片路径 / URL |
| `features.qzone.dailyLimit` | 每日空间发布上限，默认 1 条 |

额度为 0 表示禁止对应动作。计数按 `Asia/Shanghai` 每日零点重置，默认保存到 `SESSION_STORE` 同目录的 `daily-usage.json`，可通过 `BOT_USAGE_STORE` 指定路径。额度在调用 OneBot 前原子落盘；写入失败不执行动作。远端失败、取消或结果未知仍保留预扣，避免重试造成超额。审批拒绝或审批期间取消不扣额度。损坏的额度文件会阻止启动并保留原文件。一个额度文件由一个桥接实例管理，不支持多个桥接实例同时写入。

内部动作服务只监听本机随机端口，每次启动生成独立凭据，通过 ACP 显式传给 MCP，并绑定对应模型轮次。轮次结束、超时或会话重建后，旧的待审批请求不能继续执行。单独运行 `npm run mcp` 可用于发现工具；受管动作需要桥接自动挂载的连接配置，缺失时返回错误，不绕过额度直连 OneBot。

目前没有定时主动聊天调度器；以上主动发言配置约束模型调用 QQ 发送工具的行为。浏览器开关与浏览额度仍未接入外部浏览器 MCP。

## 审批

- 读、搜索、fetch：自动允许；
- 编辑、移动文件：转管理员审批；当前未实现可靠的工作区路径校验，因此不自动允许；
- 执行命令：默认转管理员审批，`allowExec=true` 时自动允许；
- 管理员回复 `y 编号` 放行、`n 编号` 拒绝；仅有一项待审批时也可直接回复 `y` / `n`；
- 删除、类型未知：拒绝。

没有管理员、审批超时、通知发送失败、轮次取消或缺少匹配审批选项时拒绝或取消审批。

## 故障处理与测试

同一会话的模型生成和回复发送串行执行。轮次超时后取消请求、丢弃异常会话，后续消息创建新会话；OneBot HTTP 请求最多等待 15 秒。DSH 初始化最多等待 30 秒，DSH 异常退出会关闭桥接并以非零状态退出，需要手动或由进程管理器重启。退出时尝试保存配置和会话映射、关闭连接并清理 DSH 子进程。

模型及回复处理默认最多并发 4 个会话；每个会话最多接收 5 条待处理消息，全局最多 50 条，容量均包含正在处理的消息。可通过 `MAX_CONCURRENT_TURNS`、`QUEUE_PER_CONVERSATION`、`QUEUE_TOTAL` 调整，重启生效。超过容量的消息会被丢弃，不会稍后自动补答；私聊会发送忙碌提示，同一会话 15 秒内最多提示一次。管理员审批回复先于消息队列处理，不受队列容量阻塞。管理状态的 `pendingMessages`、`messagesDropped` 分别表示当前处理及等待消息总数、启动后因容量不足丢弃的消息数。

OneBot WebSocket 握手最多等待 10 秒，连接后每 30 秒发送 ping；下一次检测仍没有 pong 或其它消息时断开，3 秒后重连。每次连接会重新查询登录信息，OneBot 的 heartbeat 事件同步 QQ 在线状态。入口校验消息结构并忽略异常事件；去重缓存按账号及会话区分，保留最近 1000 条、最多 10 分钟，逐条淘汰。回复分片不会从 emoji 的 UTF-16 代理对中间切开。

```powershell
npm run typecheck
npm test
```

测试使用临时目录、假的 ACP / OneBot 服务与真实 QQ MCP 子进程，验证消息顺序、超时恢复、审批取消、配置热更新、并发额度、重启计数、跨日重置、突发消息限流、握手超时及心跳重连，不连接真实 QQ 或调用模型。
