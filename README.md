# QQ-BOT · 小鲸工作台

基于 DSH（ACP）与 NapCat（OneBot 11）的 QQ 机器人，提供 Windows 原生 WPF 控制台，支持私聊、群聊、人设、长期记忆和受权限与额度约束的 QQ 操作。

```text
QQ ↔ NapCat / OneBot 11 ↔ bridge ↔ DSH（ACP）
                            └── QQ MCP 工具与后台资料整理
```

## 功能

| 范围 | 能力 |
| --- | --- |
| 聊天 | @、称呼、前缀、引用与追问；关键词、概率或全部参与；消息聚合、排队与超时控制 |
| 人设与记忆 | 命名人设库、全局和会话人设；群友记忆与工作区文本记忆 |
| 后台整理 | 按来源核对记忆、冲突与版本管理；群内用语候选、人工确认和按话题召回 |
| 联网核实 | 使用 DSH / DeepSeek 原生搜索与网页读取，回答附实际来源链接 |
| QQ 操作 | 最多 51 个 MCP 工具：消息、联系人、表情、图片、语音、文件、提醒、资料、点赞与空间 |
| 空间互动 | 复用 NapCat 登录浏览自己或好友说说、发表评论与回复；独立开关、额度及正文确认 |
| 自主行为 | 独立调度聊天、表情收藏、空间创作与好友空间互动；无需新指令，可自然选择文字、表情或语音，受安静时段和额度约束 |
| 上下文管理 | 群背景、记忆和用语字数预算；QQ 工具次数限制、条件挂载与可选会话换代 |
| 桌面管理 | 四步快速配置、环境检测、安装指引、启停与模型重连、动态设置、QQ 活动、日志、诊断与托盘 |

后台记忆和用语学习默认关闭；启用后还需指定允许学习的会话。真实 QQ、搜索、媒体和空间能力取决于所连接的协议端与服务。配置方法和边界见[使用指南](docs/usage.md)。

## 环境要求

以下为源码运行要求。已新增内置 Node/npm 和生产依赖的内部发行目录构建，以及工作台内的组件准备入口，详见[组件与打包](docs/components-and-packaging.md)。当前仍是验证阶段，尚未满足正式发布门槛。

- Node.js **22.13–22.x，或 24 及以上**，以及 npm。
- 已安装 DSH，知道其启动文件位置。
- 原生桌面端需要 Windows 10/11 与 .NET Framework 4.8，无需 Electron 或 .NET SDK。
- 接真实账号需要已登录的 NapCat / OneBot 11；也可复用外部已运行的 OneBot。

## 快速开始

在项目根目录运行：

```powershell
npm ci
npm run setup
npm run desktop:build
npm run desktop
```

`setup` 只补建缺失的 `.env` 和默认 `bot-workspace/AGENTS.md`，不会覆盖已有配置或人设。自定义工作区需自行准备并在连接设置中选择。

首次打开控制台会补建缺失的配置与默认人设；未配置 DSH 时自动进入「快速配置」，也可从工作总览随时打开：

1. **检测环境**：可先点击「准备运行组件」，或检测已安装的 DSH、QQ 路径，选择本机启动 NapCat 或连接已有 QQ 服务。
2. **选择模型**：已有 DSH 配置或账号可直接复用；新用户可选择本项目 API Key，填写密钥并测试实际回复。
3. **连接 QQ**：核对 HTTP / 正向 WebSocket 地址与令牌。默认端口为 3000 / 3001，机器人 QQ 自动识别。
4. **检查并启动**：检查当前草稿、依赖、HTTP 鉴权及 WebSocket 通道，通过后保存并启动。也可仅保存，稍后再启动。

快速配置与全部连接设置共用同一份草稿，切换不会丢失输入。自动检测只补全空白或默认路径，不覆盖手填内容；检查不调用对话模型、不发送 QQ 消息。更改输入后需重新检查。媒体、搜索、人设及管理员等行为参数可在基础聊天启动后再配置，详见[首次配置与组件安装](docs/usage.md#首次配置与组件安装)。

测试模型连接会发送一条真实请求，可能产生少量费用。更换工作区后重新打开控制台，加载对应的人设与记忆。

### 选择 QQ 接入方式

| 选择 | 适合的情况 | 需要准备 |
| --- | --- | --- |
| 自动连接（默认） | 已有服务优先，不可用时启动本机 NapCat | 可连接的 OneBot，或已部署的本机运行组件 |
| 工作台启动本机 NapCat | 希望工作台负责 QQ 进程的启停 | QQ 安装目录、NapCat Shell 与官方 Node 适配库 |
| 连接已运行的 QQ 服务 | 已用其他方式启动 NapCat，或使用远程服务 | HTTP / 正向 WebSocket 地址与令牌，无需本机 QQ 与 NapCat |

选择已有服务后，即使服务暂时离线，也不会误启动本机 QQ。依赖检查中的「可跳过」不会阻止启动；「需处理」可点击定位。基础检查通过后，还需等待工作总览显示 QQ 在线、模型就绪，再发私聊或 @ 消息验证。

### 更新与运行文件

程序与数据目录的启动契约已经接入，源码继续使用原目录；内部发行目录默认使用用户目录，也支持显式便携/自定义目录。正式安装、升级和回退流程仍待交付，规则与升级方法见[运行布局说明](docs/runtime-layout.md)。

更新项目时，从托盘选择「退出并停止机器人」，再运行 `npm ci` 和 `npm run desktop:build`，随后重新打开工作台。

可以直接双击根目录的 `QQ-BOT.exe`，运行时需保留完整项目目录，尤其是 `package.json`、`desktop/`、`dist/`、`node_modules/`、`scripts/`、`templates/` 和 `.env.example`。EXE 由本机构建，不包含在源码仓库中。可选的 `runtime/node.exe` 是本机便携运行库；未提供时使用系统 Node.js。

## 对话模型

| 方式 | 配置 | 凭据来源 |
| --- | --- | --- |
| 沿用 Profile | `BOT_CHAT_MODE=profile` | `BOT_DSH_PROFILE` 指定的 DSH 配置，默认 `acp` |
| 本项目 API Key | `BOT_CHAT_MODE=project` | 本地 `.env` 中的项目 Key、模型和 Messages 地址 |
| 账号登录 | `BOT_CHAT_MODE=account` | DSH 已登录的 DeepSeek 账号 |

项目 Key 示例：

```dotenv
BOT_CHAT_MODE=project
BOT_CHAT_MODEL=deepseek-flash
BOT_CHAT_BASE_URL=https://api.deepseek.com/anthropic
QQ_BOT_DEEPSEEK_API_KEY=填写自己的密钥
```

官方根地址及其 `/v1` 地址会自动转换到 `/anthropic`；自定义服务需兼容 Messages 协议。密钥保存在本项目 `.env`，不会写入 DSH 全局凭据。仅修改对话模型时可重连桥接并保留 QQ 登录。

## 工程目录

```text
src/
  bridge.ts             桥接启动入口，构建后仍为 dist/bridge.js
  mcp-qq.ts             MCP 启动入口，构建后仍为 dist/mcp-qq.js
  core/                 配置、会话存储、队列、消息处理、审批与额度
  qq/                   OneBot、群记录、QQ 动作、社交记录与工具
  agent/                模型选择、记忆整理、群内用语、自主行为与上下文
  services/             媒体、空间、内部动作 HTTP 服务与客户端
desktop/                原生 WPF 界面、Node 配置与进程管理
scripts/                构建、初始化、NapCat 启动
  dev/                  假 OneBot 等开发工具
templates/              可提交的默认人设
tests/                  单元与集成测试、隔离夹具、原生窗口测试
docs/                   使用指南与开发说明
bot-workspace/          本机人设、记忆与输出（Git 忽略）
data/                   本机会话、聊天、媒体与日志（Git 忽略）
napcat/                 本机协议运行环境与账号配置（Git 忽略）
dist/                   自动生成的 JavaScript 与调试映射（Git 忽略）
```

构建成功后会清理已删除或移动模块的旧 JavaScript 和映射，避免目录调整留下重复产物。联网统一使用 DSH 原生搜索与网页读取工具。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 初始化缺失的本地配置与默认人设 |
| `npm run build` | 编译桥接与 MCP，清理过期构建文件 |
| `npm run desktop:build` | 编译桥接并生成 Windows EXE |
| `npm run desktop` | 打开工作台；缺少 EXE 时自动构建 |
| `npm start` | 使用 `.env` 启动已构建的桥接 |
| `npm run napcat` | 启动已部署的 NapCat Node 环境 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 构建并运行隔离自动测试 |
| `npm run test:isolated` | 在临时检出副本编译测试，保护本机 `dist/` |
| `npm run benchmark:store` | 使用合成消息测量 JSON 存储开销 |

假 OneBot 联调、原生窗口测试和维护方法见[开发说明](docs/development.md)。单独运行 `npm run mcp` 可发现工具，实际受管操作需桥接自动传入的连接凭据。

## 本地数据与 Git

仓库只保存源码、测试、模板和无密钥示例。个人工作区已取消跟踪，`.gitignore` 排除整个 `bot-workspace/`，本地人设原样保留。

依赖、编译输出、生成的 EXE、便携运行库、界面测试截图、日志及临时备份同样排除；`desktop/assets/` 的源素材、`templates/`、`.env.example` 和无密钥的 `tests/fixtures/mock.env` 继续提交。

| 内容 | 默认位置 |
| --- | --- |
| 连接、模型和密钥 | `.env` |
| 动态机器人设置 | `bot.config.json` |
| 会话、额度、社交记录、媒体与运行日志 | `data/` |
| 全局人设 | `bot-workspace/AGENTS.md` |
| 命名人设库 / 文本记忆 | `bot-workspace/.whale/` / `bot-workspace/memory/` |
| NapCat 运行库、登录与账号配置 | `napcat/` |

自定义本地工作区或数据目录位于仓库内时，须补充对应忽略规则。备份前先停止机器人，再复制配置、工作区、数据和 NapCat 账号目录。数据升级生成的 `social.json.v1-*.bak` 是恢复备份，应保留。

## 运行说明

- 「保存机器人设置」保存行为配置；「保存连接与媒体」保存该页内容，两者不会携带另一页未保存的草稿。
- `bot.config.json` 的显式值优先于环境默认值，保存后热更新；连接地址与凭据修改通常需要重启。
- 工作台关闭窗口后隐藏到托盘；从托盘选择「退出并停止机器人」才停止受管进程。外部启动的 OneBot 不会被工作台结束。
- 同一数据资源只允许一个桥接写入，重复启动会明确拒绝。首次升级前先停止所有旧桥接；运行时不要删除 `*.qqbot-lock.sqlite` 互斥侧文件。超时、损坏数据、权限或服务不可用时，先看工作日志和启动诊断。
- 自动测试使用隔离数据与模拟服务；不能据此判断真实 QQ 接口、付费服务可达性或模型理解质量。

项目代码采用 [MIT 许可证](LICENSE)。第三方组件与依赖继续遵守各自许可，NapCat 的个人非商业使用与组件获取方式见[组件说明](docs/components-and-packaging.md)。

服务器运行与浏览器管理见[云端控制台方案](docs/cloud-console-plan.md)。该部分尚未实现，当前内部发行包只用于 Windows 验证。
