# QQ-BOT

QQ 自主操作升级、桌面管理入口、媒体服务配置与实际可用边界见 [升级说明](UPGRADE.md)。

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

首次运行会在 `~\.dsh\profiles\acp` 创建 Profile。默认沿用该 Profile 的模型配置；
也可在桌面端「连接与运行 → 对话模型」选择「本项目 API Key」，填写密钥、选择模型，获取模型列表并测试实际回复。
测试使用当前输入，不保存配置，会发送一条可能产生少量费用的简短请求。

项目独立配置使用 `.env` 的 `BOT_CHAT_MODE=project`、`BOT_CHAT_MODEL`、`BOT_CHAT_BASE_URL` 和
`QQ_BOT_DEEPSEEK_API_KEY`；API 地址默认是 DeepSeek 官方 Messages 入口，自定义地址也需支持 Messages 协议。
密钥不会写入 DSH 全局凭据；启动时在 `SESSION_STORE` 同目录的 `dsh/chat-model.patch.json` 生成不含密钥的覆盖配置。
`BOT_CHAT_MODE=account` 复用 DSH 已登录的 DeepSeek 账号；`profile` 沿用已有 Profile，保留原来的调用方式。
只修改对话模型时，「保存并重新启动」会重连模型并保留 QQ 登录；其他连接参数变化仍完整重启。
重连后，新建与恢复的会话都会应用选中的模型，无需清空会话上下文。

## 接入真 QQ

1. 安装 NapCat（Windows 一键包），登录小号；
2. NapCat 网络配置：HTTP `127.0.0.1:3000`、WS `127.0.0.1:3001`，设置 token，消息格式选择消息段数组；
3. 复制 `.env.example` 为 `.env`，填 `ONEBOT_TOKEN`、`BOT_SELF_ID`、`ADMIN_QQ`；
4. 桥接会在新建和恢复 ACP 会话时自动挂载名为 `qq` 的 MCP，并传入绑定会话的内部动作接口凭据，所有 QQ 工具由桥接统一执行。升级前若已在 acp profile 中手动配置 `mcp-qq` / `serverName: qq`，请移除旧的重复配置；其它 MCP（如浏览器）保留原有配置；
5. `npm start`

## 配置与管理

### Windows 桌面控制台

运行 `npm run desktop` 打开“小鲸工作台”（没有 EXE 时自动构建）。更新源码后先运行 `npm run desktop:build`，也可直接双击项目根目录的 `QQ-BOT.exe`；EXE 需与 `desktop`、`dist`、`node_modules` 目录保留在一起。需要 Windows 10/11 自带的 .NET Framework 4.8 和 Node.js 22 以上，不需要安装 Electron、浏览器服务或 .NET SDK。生成桌面快捷方式：`powershell -NoProfile -ExecutionPolicy Bypass -File desktop/build.ps1 -Shortcut`。

- 首页提供启动、停止和重新启动，同时管理独立 Node 模式 NapCat 与机器人桥接；操作期间禁用重复点击。请先按下文部署 NapCat 官方运行库及 QQ，首次登录按 NapCat 日志完成扫码；未登录时不会显示 QQ 在线。
- 工作总览分别显示 QQ、模型、消息和队列状态；“重连模型”仅重启桥接，保留 NapCat 的登录进程。检测到已运行的 OneBot 会复用其连接，并注明外部进程，退出时不结束外部 NapCat。
- 关闭窗口隐藏到托盘，单击图标恢复；重复打开 EXE 唤回已有窗口。右键托盘选择“退出并停止机器人”才会停止两个受管进程并退出，不接管外部终端启动的实例。
- 机器人设置使用顶部 7 个主题分类，支持搜索、分组卡片、数字步进、行内范围提示和关联开关；管理员 QQ 使用纯数字文本输入。切换分类保留未保存输入，保存时统一校验并热更新。浏览器字段目前只保存配置，尚未接入外部 MCP。
- QQ 活动采用记录列表与右侧详情布局，显示会话类型、状态与时间；按所选记录提供记忆保存、屏蔽、提醒取消和会话设置操作。可用 Enter 搜索、拖动分隔栏调整详情宽度；空记录和读取中状态有独立提示。
- 连接与运行页提供 QQ 连接、对话模型、媒体模型、消息处理、存储与高级 5 个顶部分类，支持路径选择、隐藏令牌输入和行内校验。对话模型可沿用 DSH Profile、使用项目独立 Key 或复用 DSH 账号；提供模型获取与连接测试。媒体服务与模型名称集中配置，并与机器人设置双向同步。可选择“保存配置”或“保存并重新启动”，校验或保存失败时不重启，媒体模型保存失败时还原连接文件；保存连接配置保留其他尚未保存的机器人设置。
- 高级区域可编辑完整 `.env`，保留自定义参数和注释；表单和高级文本在保存当前修改后才能切换编辑，避免互相覆盖。连接参数重启生效，媒体模型设置可热更新；`bot.config.json` 的显式值仍优先于 `.env` 的同名默认值。
- 人设与记忆页按人设库、群友记忆、工作区记忆分成 3 个顶部分类。可新建、命名、另存、修改和删除多套人设，或将已保存的人设设为全局人设；全局内容仍保存到 `BOT_WORKSPACE/AGENTS.md`，新会话生效。人设库保存在工作区 `.whale/personas.json`，单条最多 10000 字。
- 「QQ 活动 → 会话人设与参与」可选择库内人设、沿用全局或填写自定义内容。选择后复制到本会话，可继续微调；保存的会话保留独立副本，后续修改或删除库内人设不会改动已有会话。
- 群友记忆支持按名字、QQ、群号和内容搜索、编辑与删除；运行时直接操作桥接中的同一份记录。工作区记忆支持在页面内新建、查看、编辑和删除 `memory` 目录下的 `.md` / `.txt` 文件，支持子目录和内容搜索。切换分类与条目保留草稿；保存时检查外部修改，发生冲突时保留当前编辑。修改 `BOT_WORKSPACE` 后请重新打开控制台再管理对应工作区。
- 停止桥接先发送 IPC 退出请求，等待保存会话与额度；超时后清理该受管进程树。托盘退出同样执行此流程。NapCat 使用进程树终止。

桌面端采用原生 WPF 与标准输入输出 JSON 通信，不监听额外网络端口。窗口日志保留最近 1500 行，支持搜索、来源 / 错误筛选和导出；暂停滚动不影响机器人运行。脱敏日志保存在 `data/desktop/console.log`，超过 2 MB 后保留上一份，重新打开显示最近 100 行。启动诊断检查 Node、QQ / NapCat 依赖、配置路径、DSH Profile 权限与进程完整性级别。不要同时从终端和桌面端启动同一桥接，避免数据目录冲突。

Windows 低完整性目录会使生成的 EXE 继承低完整性级别，导致系统托盘不可用、DSH 无法写入用户目录（`EPERM ... cordis.yml`）。构建脚本只对生成的 EXE 设置普通用户的 Medium 完整性标签，不改目录 ACL、不申请管理员权限。遇到这两类问题时，退出后重新运行 `npm run desktop:build`；程序也会在启动诊断中提示。托盘使用原生 Shell 注册并定时检查，Explorer 重启后自动重新注册；注册失败时保留任务栏窗口。

鲸鱼图标由 `desktop/assets/whale.xaml` 的矢量绘图生成，包含 16–256 像素共八档 ICO，统一嵌入 EXE、窗口与托盘。修改后运行桌面构建即可更新。

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

已增加持久化提醒与定时主动聊天机会，配置和额度规则见 [升级说明](UPGRADE.md)。浏览器开关与浏览额度仍未接入外部浏览器 MCP。

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
# Windows 原生窗口、托盘隐藏与重复启动恢复（先 npm run desktop:build）
powershell -NoProfile -ExecutionPolicy Bypass -File tests/desktop-smoke.ps1
```

测试使用临时目录、假的 ACP / OneBot 服务与真实 QQ MCP 子进程，验证消息顺序、超时恢复、审批取消、配置热更新、并发额度、重启计数、跨日重置、突发消息限流、握手超时及心跳重连，不连接真实 QQ 或调用模型。
