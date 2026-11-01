# QQ-BOT · 小鲸工作台

基于 DSH（ACP）与 NapCat（OneBot 11）的 QQ 机器人，提供 Windows 原生控制台，支持私聊、群聊、人设、长期记忆和受权限与额度约束的 QQ 操作。机器人可以运行在本机，也可以部署在 Linux 服务器由 `whaled` 守护，Windows 控制台通过 SSH 远程管理。

```text
QQ ↔ NapCat / OneBot 11 ↔ bridge ↔ DSH（ACP）
                            └── QQ MCP 工具与后台资料整理
```

## 下载与安装

发行包放在 [Releases](https://github.com/openyourass66/QQ-BOT/releases)，当前版本 **0.2.1**，提供 Windows x64 与 Linux x64 两种布局。

### Windows 10/11 x64

1. 下载 `WhaleWorkbench-0.2.1-win-x64.zip` 和对应的 `.sha256`，校验摘要后**完整解压**。
2. 双击 `WhaleSetup.exe` 安装或升级；已有安装也可从工作台“安装、升级与回退”入口打开。
3. 安装完成后从开始菜单“小鲸工作台”或程序目录的 `WhaleLauncher.exe` 启动。
4. 只想试用时，可直接双击包内“开始使用.cmd”，数据保存在包旁的 `user-data/`。

不要单独复制 EXE，必须保留 `runtime/`、`desktop/`、`dist/`、生产依赖和发行清单。安装与回退细节见[安装与升级说明](docs/install-and-upgrade.md)。

### Linux x64 服务器

```bash
sha256sum -c WhaleWorkbench-0.2.1-linux-x64.tar.gz.sha256
tar -xzf WhaleWorkbench-0.2.1-linux-x64.tar.gz -C /tmp
```

首次安装先写入 systemd 单元，再用发行目录执行安装；后续升级只替换程序文件，不改写数据：

```bash
sudo node /tmp/WhaleWorkbench-0.2.1-linux-x64/scripts/whaled-install.mjs \
  --data-dir /var/lib/whaleworkbench \
  --program /opt/whaleworkbench/current \
  --node /opt/whaleworkbench/current/runtime/bin/node \
  --service whaled.service --no-start

sudo node /tmp/WhaleWorkbench-0.2.1-linux-x64/scripts/whaled-upgrade.mjs \
  --package /tmp/WhaleWorkbench-0.2.1-linux-x64 \
  --install-root /opt/whaleworkbench \
  --data-dir /var/lib/whaleworkbench \
  --trust /tmp/WhaleWorkbench-0.2.1-linux-x64/components/release-trust.json
```

已有安装会自动使用 `/opt/whaleworkbench/trust.json`，可省略 `--trust`。`--dry-run` 只校验不切换，`--rollback` 回到上一版，`--recover` 处理上次中断的升级。完整步骤见[安装与升级说明](docs/install-and-upgrade.md#linux-服务器部署分支)。

> 当前发行包使用内部验证签名通道（`internal-validation`），会校验发行清单和全部文件，但不代表正式发布者身份。

## 功能

| 范围 | 能力 |
| --- | --- |
| 聊天 | @、称呼、前缀、引用与追问；关键词、概率或全部参与；消息聚合、排队与超时控制 |
| 人设与记忆 | 命名人设库、全局和会话人设；群友记忆与工作区文本记忆 |
| 后台整理 | 按来源核对记忆、冲突与版本管理；群内用语候选、人工确认和按话题召回 |
| 联网核实 | 使用 DSH / DeepSeek 原生搜索与网页读取，回答附实际来源链接 |
| QQ 操作 | 消息、联系人、表情、图片、语音、文件、提醒、资料、点赞与空间工具 |
| 空间互动 | 复用 NapCat 登录浏览自己或好友说说、发表评论与回复；独立开关、额度及正文确认 |
| 自主行为 | 独立调度聊天、表情收藏、空间创作与好友空间互动；受安静时段和额度约束 |
| 上下文管理 | 群背景、记忆和用语字数预算；QQ 工具次数限制、条件挂载与可选会话换代 |
| 桌面管理 | 四步快速配置、环境检测、安装指引、启停与模型重连、动态设置、QQ 活动、日志、诊断与托盘 |
| 远程管理 | Windows 控制台通过 SSH 连接 Linux 实例，断线后自动重连 |
| 权限与凭据 | 真实主人身份及操作内容确认、模型工具守卫、请求与 QQ 动作预算；Windows 发行布局使用加密凭据 |
| 数据与恢复 | SQLite 存储、迁移保护、入站去重、事务额度与动作记录；停机加密备份、校验、恢复及中断处理 |
| 媒体维护 | 容量与引用索引、有界视频抽帧、图形化停机预览与确认清理 |

后台记忆和用语学习默认关闭；启用后还需指定允许学习的会话。真实 QQ、搜索、媒体和空间能力取决于所连接的协议端与服务。配置方法和边界见[使用指南](docs/usage.md)。

## 首次使用

首次打开控制台会补建缺失配置与默认人设；未配置 DSH 或尚未选择联系范围时自动进入「快速配置」：

1. **检测环境**：准备 DSH 与 QQ 运行组件，或检测已有安装；也可以连接已经运行的 OneBot 服务。
2. **选择模型**：复用已有 DSH 配置，或填写本项目 API Key 并测试实际回复。
3. **连接 QQ**：受管组件点击「配置并登录 QQ」，按手机提示扫码；外部服务填写 HTTP / WebSocket 地址与令牌。
4. **选择范围并启动**：选择机器人主人及允许聊天的好友和群，检查后保存并启动。

新实例默认只开放明确选择的会话，关闭后台自主判断、自动收藏与空间创作。快速配置与全部连接设置共用同一份草稿，切换不会丢失输入。详细步骤见[使用指南](docs/usage.md#首次配置与组件安装)。

测试模型连接会发送一条真实请求，可能产生少量费用。首次准备组件需要联网，组件来源、版本和校验方式见[组件与打包](docs/components-and-packaging.md)。

### QQ 接入方式

| 选择 | 适合的情况 | 需要准备 |
| --- | --- | --- |
| 自动连接（默认） | 已有服务优先，不可用时启动本机 NapCat | 可连接的 OneBot，或已部署的本机运行组件 |
| 工作台启动本机 NapCat | 希望工作台负责组件准备、扫码与进程启停 | 工作台内准备固定组件；手工 Shell 模式另需 QQ 安装目录和适配库 |
| 连接已运行的 QQ 服务 | 已用其他方式启动 NapCat，或使用远程服务 | HTTP / 正向 WebSocket 地址与令牌 |

选择已有服务后，即使服务暂时离线，也不会误启动本机 QQ。登录失效后仍可能需要按官方流程重新扫码；更新启动脚本须点击「重新启动」。详见[QQ 登录与隔离](docs/qq-login.md)。

## Linux 服务器与远程控制台

- 服务器侧：`whaled` 持有单实例锁与子进程，负责启停、维护、备份和开机恢复；关闭控制台、退出 SSH 或网络中断都不会停止机器人。管理接口只走数据目录下的 unix socket，公网只需开放 SSH。
- 控制台侧：在「连接与运行 → 服务器连接」新建配置，填写主机、SSH 端口、用户名、私钥、服务器上的 Node、程序目录和数据目录。首次连接会显示主机密钥指纹并要求确认，之后变更必须再次确认。
- 远程文件：备份、恢复、迁移、诊断、组件导入和日志下载通过暂存目录与 scp 传输，操作完成后清理暂存文件。
- 已知边界：远程模式隐藏 Windows 专属的安装、注册表和开始菜单入口；QQ 登录态不能跨机器迁移，需要在目标实例重新扫码。

## 数据、备份与升级

| 运行方式 | 数据位置 |
| --- | --- |
| 源码运行 | 当前项目目录 |
| Windows 安装版直接打开 `QQ-BOT.exe` | `%LOCALAPPDATA%/WhaleWorkbench` |
| Windows 发行包“开始使用.cmd” / `--portable` | 包目录的 `user-data/` |
| `--data-dir 路径` | 显式指定的独立目录 |

- 停机维护入口在“连接与运行 → 存储与高级 → 数据备份与恢复”。备份使用密码加密，恢复前保留当前数据的加密恢复点；QQ / DSH 账号登录态不包含在备份中。
- 升级只替换程序文件，不改写数据库、配置和凭据；Linux 升级失败会自动切回上一版。回退同样受数据库 schema 限制。
- 同一数据资源只允许一个桥接写入，重复启动会明确拒绝；运行时不要删除 `*.qqbot-lock.sqlite` 互斥侧文件。
- 工作台关闭窗口后隐藏到托盘。本地模式从托盘选择「退出并停止机器人」；远程模式该操作只关闭控制台，服务器上的机器人继续运行。

详细说明见[运行布局](docs/runtime-layout.md)、[存储与备份](docs/storage.md#停机加密备份与恢复)和[权限与安全](docs/security-policy.md)。

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

官方根地址及其 `/v1` 地址会自动转换到 `/anthropic`；自定义服务需兼容 Messages 协议。Windows 普通发行布局通过 DPAPI 保护受管凭据，换 Windows 用户或机器后须重新输入。仅修改对话模型时可重连桥接并保留 QQ 登录。

## 从源码运行

源码运行需要 Node.js **22.20–22.x，或 24 及以上**，以及 npm。原生桌面端需要 Windows 10/11 与 .NET Framework 4.8，无需 Electron 或 .NET SDK。旧 Node 22.13 已复现数据库原生崩溃，不作为应用运行环境。

```powershell
npm ci
npm run setup
npm run desktop:build
npm run desktop
```

`setup` 只补建缺失的 `.env` 和默认 `bot-workspace/AGENTS.md`，不会覆盖已有配置或人设。构建产物不包含在源码仓库中，需保留完整项目目录。

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 初始化缺失的本地配置与默认人设 |
| `npm run desktop:build` | 编译桥接与 MCP，生成 Windows EXE |
| `npm run desktop` | 打开工作台；缺少 EXE 时自动构建 |
| `npm start` | 使用 `.env` 启动已构建的桥接 |
| `npm run napcat` | 启动已部署的 NapCat Node 环境 |
| `npm run components` | 固定组件的准备与核对入口 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 构建并运行自动测试 |
| `npm run test:isolated` | 在临时副本中编译测试，保护本机 `dist/` |
| `npm run package:dir -- --output release/候选目录 --zip` | 生成 Windows 发行目录、ZIP 与摘要 |
| `npm run package:linux -- --output release/linux目录 --zip` | 生成 Linux x64 发行目录与 ZIP |
| `npm run whaled` | 在 Linux 服务器启动受管守护进程 |

模块边界、原生窗口测试和维护方法见[开发说明](docs/development.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/usage.md) | 首次配置、组件安装、日常操作与能力边界 |
| [QQ 登录与隔离](docs/qq-login.md) | 受管 QQ 配置、扫码、登录失效与账号目录隔离 |
| [安装与升级](docs/install-and-upgrade.md) | Windows / Linux 安装、升级、回退、修复与卸载 |
| [运行布局](docs/runtime-layout.md) | 程序目录、数据目录、便携模式与启动入口 |
| [存储与备份](docs/storage.md) | SQLite 存储、迁移、停机加密备份与恢复 |
| [权限与安全](docs/security-policy.md) | 主人身份、操作确认、工具守卫与凭据保护 |
| [组件与打包](docs/components-and-packaging.md) | 固定组件来源、准备流程与发行目录构建 |
| [浏览器控制台](docs/cloud-console.md) | 可选私有网页控制台的预览与使用 |
| [开发说明](docs/development.md) | 模块边界、测试、构建与原生窗口验证 |

## 许可

项目代码采用 [MIT 许可证](LICENSE)。第三方组件与依赖继续遵守各自许可，NapCat 的个人非商业使用与组件获取方式见[组件说明](docs/components-and-packaging.md)。发行包不包含个人配置、聊天记录或登录资料。
