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

### Windows 桌面控制台

控制台采用蓝色小鲸鱼主题：云白背景、浅蓝导航、圆角卡片与鲸鱼插画。生成桌面 EXE 和快捷方式：

```powershell
npm run desktop:build
```

之后双击项目根目录的 `QQ-BOT.exe` 或桌面上的 `QQ-BOT` 快捷方式即可启动，无需打开终端。EXE 是桌面启动入口，须与项目文件一起保留，使用已安装的 Node.js。需要自带 Node 的便携目录时运行 `npm run desktop:portable`，产物位于 `release/QQ-BOT`，将整个目录一起移动；目录不包含本机 `.env`、账号、NapCat、聊天记录或人设，请根据 `.env.example` 配置连接及 DSH，并准备 NapCat 环境。

开发时也可直接运行：

```powershell
npm run ui
```

使用 Windows 自带的 WPF 与 Windows PowerShell 5.1，沿用项目的 Node.js 22+，不需要 Electron、WebView 或浏览器，也不新增 npm 依赖。首次使用先 `npm install`；启动命令自动构建后打开原生桌面窗口，不会自动启动机器人。

控制台提供启动、停止、重启、连接状态、消息统计、动态配置、人设编辑、会话重置、日志筛选和管理员测试消息。机器人停止后仍可编辑配置、查看日志并重新启动。关闭窗口会隐藏到系统托盘，机器人继续运行，未保存的编辑保留；单击或双击鲸鱼托盘图标，或右键选择“打开控制台”即可恢复。彻底退出请右键托盘图标选择“退出并停止机器人”，此时会停止本窗口启动的机器人并清理 DSH 子进程，有未保存的配置或人设时会提示确认。配置和人设保存失败会保留输入。

完成构建后，也可以双击 `desktop/launch.vbs` 启动，后台不显示命令行窗口。连接地址、OneBot 令牌、DSH 路径等启动参数通过“连接配置 (.env)”打开本地记事本编辑，保存后需要从托盘彻底退出并重新打开控制台。运行中的 `npm start` 桥接需先退出，再交由桌面控制台启动，避免重复连接和数据文件争用。同一项目的桌面窗口通过系统互斥量限制为一个实例；再次启动 EXE 会通知已有实例恢复窗口，保留机器人运行和未保存的编辑。

桌面窗口通过本机随机端口与独立控制进程通信，每次启动使用独立随机令牌；该接口仅作进程间通信，不提供网页界面。日志最多保留 500 条，最小化或隐藏到托盘时暂停状态轮询，关闭日志页后停止拉取日志。桌面 UI 的自检可运行：

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File desktop/start.ps1 -ValidateOnly
```

如果本机 Shell 方式的 NapCat 在加载 QQ 时崩溃，可使用独立 Node 运行环境。`desktop/napcat-node.mjs` 从 `BOT_QQ_DIR` 中读取当前 QQ 版本，把所需文件复制到项目的 `napcat/node-runtime`，不修改系统 QQ。需先解压官方 NapCat Shell 到 `napcat/shell`，并将官方 Node 运行适配库 `QQNT.dll` 部署到 `napcat/node-runtime/QQNT.dll`；它与系统 QQ 的同名文件用途不同。参考 [官方 Node 环境准备脚本](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-develop/loadNapCat.cjs)。本地 `.env` 配置示例：

```dotenv
BOT_NAPCAT_ENTRY=desktop/napcat-node.mjs
BOT_QQ_DIR=D:\app\qq
```

配置后，点击启动时若 OneBot HTTP 端口尚未监听，控制台会启动该 Node 运行环境；停止、重启、从托盘彻底退出会清理控制台自己启动的 NapCat。已在外部运行的 NapCat 会复用并保持独立。首次部署会复制 `napcat/shell/config` 中对应 `BOT_SELF_ID` 的账号与 OneBot 配置；后续配置以 `napcat/node-runtime/config` 为准。首次登录可能需要扫码。连接尚未完成时，概览会显示“等待 NapCat”或“等待 QQ 登录”，测试发送按钮保持禁用。

直接运行 `npm start` 时，本地管理 API 默认位于 `http://127.0.0.1:6080`，可通过 `ADMIN_UI_PORT` 修改端口，设置 `ADMIN_UI_TOKEN` 后请求需携带 `x-admin-token`。接口包括 `/api/status`、`/api/settings`、`/api/persona`、`/api/logs`、`/api/sessions`、`/api/login-info` 和 `/api/test`。直接桥接模式不提供进程启停接口。

`requireMention=false` 会允许群消息无需 @ 或前缀直接触发；`contextLines=0` 关闭附加的最近群聊摘要，不清除 Agent 已有会话上下文。

### 群聊对话与上下文

群友发言、机器人实际发送成功的回复及群消息工具的发送结果会加入本地群记录；按机器人账号与群号隔离。默认文件为 `SESSION_STORE` 同目录下的 `group-context.json`，可通过 `BOT_GROUP_CONTEXT_STORE` 指定路径。每群保留最近 24 小时最多 80 条、单条最多 2000 字符，总计最多 100 个群；过期条目在读取上下文和后续落盘时淘汰。重启会恢复记录；在控制台重置群会话时，也会清空该群的附加记录。

每次模型真正开始处理时，才从群记录选取 `chat.group.contextLines` 条背景，包括前一轮刚发出的机器人回答，不把排队期间更晚到达的其他问题混入当前问题。ACP 自身的会话恢复继续保留。

- @ 机器人、叫配置名称 / QQ 昵称、使用前缀，以及引用最近记录中的机器人消息，都算直接对话；即使只有 @ 没正文，也会自然接一句。
- 直接对话不受 `cooldownMs` 静默丢弃，仍受消息队列容量限制；忙碌、模型超时或空回复时会有简短反馈，同群忙碌提示最多每 15 秒一条。
- `chat.group.followUpMs` 默认 90000：机器人回应后，同一群友在 90 秒内说“那为什么”“这个呢”等追问，不用重新 @。设为 0 可关闭；控制台配置中可调整。引用第三方或 @ 其他人时不自动当成追问。
- 普通旁聊仍由 `requireMention` 和冷却控制，避免插话刷屏；普通回答由桥接直接发送，不消耗 QQ 工具的主动消息额度。

OneBot 的消息段数组与 CQ 字符串格式均可识别 @ 和引用。群记录存储普通文本及媒体占位说明，不保存图片内容。

## QQ 工具额度

QQ MCP 的主动发消息、点赞和空间发布由桥接统一执行，多个会话的 MCP 子进程共享额度。普通对话回复、审批通知及管理 API 的测试消息不计入主动消息额度。

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
