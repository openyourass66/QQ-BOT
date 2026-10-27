# 开发与维护

面向普通 Windows 用户的发行、权限、存储、恢复与验收工作，见[产品化优化方案](product-readiness-plan.md)。该文档描述待实施范围与发布门槛，不代表相关改造已经完成。

当前已实现范围及验证结果见[实施进展](implementation-status.md)。

固定组件、隔离准备器与内部发行目录构建见[组件与打包](components-and-packaging.md)。`npm run package:dir` 生成内置运行环境的验证目录，不代表完成正式安装器和发布验收。

桌面与正式命令行入口使用 `scripts/app-paths.mjs`、`scripts/run.mjs` 统一运行布局；程序资源从安装目录读取，用户配置与运行文件按选定数据目录解析。入口参数和兼容规则见[运行布局说明](runtime-layout.md)。

## 模块边界

运行管理核心在 `scripts/runtime-service.mjs`，桌面标准输入/输出入口位于 `desktop/host.mjs`。其它管理入口应复用核心并增加自身认证及 DTO 边界，不能公开核心的通用命令通道或原始 `.env`。管理实例租约由 `scripts/runtime-lease.mjs` 持有，与业务数据锁分别保护。

`src/bridge.ts` 与 `src/mcp-qq.ts` 保留稳定入口。内部模块按职责划分：

| 目录 | 主要模块 | 职责 |
| --- | --- | --- |
| `core/` | config、settings、runtime、ingress、data-paths、resource-lock、store、usage、permissions | 配置、队列、入站容量、数据路径与互斥、会话映射、额度和审批 |
| `qq/` | onebot、group-context、qq-actions、social-engine、social-store、social-tools、social-admin | 协议、QQ 行为、存档、工具定义与管理操作 |
| `agent/` | chat-model、cognition、learning-model、autonomy、context-policy | 模型连接、资料整理、群内用语、自主决策与上下文预算 |
| `services/` | media、qzone、read-json、action-server、action-client | 媒体、空间、受限 JSON 响应与桥接/MCP 内部通信 |

MCP 工具通过内部动作接口交由桥接执行；权限、会话范围、额度与轮次状态在执行处再次核验。桌面 Node 辅助模块使用 `dist/` 内对应目录的编译模块。改动路径时需同步测试、动态导入和桌面引用。

桌面首次配置由 `QuickSetupView.cs` 与 `onboarding.mjs` 提供，复用 `RuntimeView.cs` 的输入控件、校验和连接保存逻辑。检测仅提供路径建议；检查使用当前草稿，不调用模型。HTTP 与 WebSocket 分开探测，修改输入会使检查结果失效。`tests/onboarding.test.mjs` 覆盖初始化保留、路径检测、外部连接与鉴权边界，原生窗口测试覆盖步骤切换、失效状态、安装指引和紧凑布局。

`ScopeSetupView.cs` 提供第四步主人及联系人选择，`setup-scope.mjs` 只读实际账号/好友/群列表，保存时重新核验账号、目标、屏蔽与配置基线。联系人列表使用虚拟化和筛选，选择先保留为连接草稿。连接保存与行为设置保存共用动态配置文件锁，网络检查后再读取最新设置以保留无关编辑。

`createInitialSettings()` 只供缺失配置文件的新实例使用，写入 `installation: { version: 1, scopeConfigured: false }` 和显式安全默认值；保存有限范围后将完成状态置为 `true`。旧文件继续按原 schema 补齐缺省值，不因升级重置已有功能。`DEFAULT_SETTINGS` 与 `validateSettings({})` 保留兼容用途，不能用于初始化新实例。安装元数据不显示在行为设置中，保存时原样保留。`tests/setup-scope.test.mjs` 覆盖新旧配置、联系人/账号变化、屏蔽、冲突和只读网络边界。

联网由当前 DSH Profile 的原生搜索与网页工具提供。项目不再维护独立 QQ 搜索服务、静态 DOM 解析器或对应缓存；QQ 工具预算不等同于 DSH 原生工具预算。

## 构建与测试

```powershell
npm ci
npm run setup
npm run typecheck
npm test
```

工作台正在运行时，优先使用 `npm run test:isolated`，在临时目录编译与回归，避免改写本机正在使用的 `dist/`。它只复制允许的源码、测试和无密钥示例，并在结束后清理临时目录。可使用 `npm run test:isolated -- --test-name-pattern=资源锁` 进行定向验证。

使用 `npm run benchmark:store -- --sizes 1000,10000,50000 --samples 10 --output report.json` 生成存储诊断报告。该命令会构建当前检出目录，运行中的工作台应使用独立检出目录执行；测量仅使用临时合成数据。

`scripts/build.mjs` 使用项目锁定的 TypeScript 编译器。编译错误时不生成新输出；成功后仅清理没有对应源文件的 `.js`、`.js.map` 和空目录，保留其他文件。保留调试映射以便排障。构建和测试都不需要真实 QQ、模型或搜索凭据。

自动测试覆盖队列与入站预算、数据资源互斥、OneBot HTTP/WS、ACP/MCP 进程、权限与额度、群上下文、表情收藏、提醒、自主行为、媒体、记忆迁移与整理、用语确认、原生联网配置、空间互动和桌面配置保存。测试使用临时目录和受控服务，不会向真实 QQ 发消息或调用付费模型。

GitHub Actions 配置 Windows/Linux、Node 22.13.0/24 的隔离回归，以及 Windows 工作台编译。原生托盘实际交互仍在具备交互桌面的机器单独验证；配置工作流不代表远端矩阵已经执行通过。

Windows 原生窗口验证：

```powershell
# 退出正在运行的工作台后构建
npm run desktop:build
powershell -NoProfile -ExecutionPolicy Bypass -File tests/desktop-smoke.ps1
```

`-SkipTrayCheck` 只跳过交互托盘检查，继续验证窗口与配置控件。没有交互桌面的环境不应把跳过的托盘测试记为通过。测试会打印隔离工作区位置，供检查界面截图。

附加 `-SeparateData` 会在临时发行布局内复制 Node，使用带空格的独立数据目录启动同一套原生测试，并检查个人文件没有写回程序目录。该夹具不会使用真实 QQ 或模型凭据，不替代成品安装验收。

## 假 OneBot 联调

```powershell
npm run build
# 终端 A
npm run mock
# 终端 B；先配置实际 DSH 启动位置
node --env-file=tests/fixtures/mock.env dist/bridge.js
```

`mock.env` 使用 3100/3101 端口与 `data/mock/`，不含密钥。DSH 启动文件默认为 PATH 中的 `dsh.cmd`；如不在 PATH，可复制为根目录 `.env.mock`，填入完整路径后使用 `--env-file=.env.mock`。此手动联调会使用真实 DSH 和模型，可能产生费用；自动化 `npm test` 使用模拟模型。

Mock 打印 `[mock] REPLY:` 表示消息链路已连通。不要将 mock 端口配置用于真实 QQ 部署。

## 目录清理

- `node_modules/` 可通过 `npm ci` 重建；依赖锁文件必须提交。开发环境保留 TypeScript 和测试所需类型。
- `dist/`、EXE、界面预览、日志、临时构建目录均是本机产物，不提交。需要调试时先保留对应日志。
- 已安装的 NapCat 中，部署后的 ZIP 和旧一键安装器可以删除；`shell/`、`node-runtime/`、账号配置、数据库及官方 Node 适配库继续保留。
- `data/`、`.env`、动态配置和个人工作区属于运行数据，不能当作缓存清理。版本迁移备份也应保留。
- `npm ci --omit=dev` 可用于仅运行已有构建产物的部署目录；开发或重新构建前应恢复完整依赖。

默认人设只提交 `templates/bot-persona.md`，由 `npm run setup` 在缺失时复制到个人工作区。不要重新跟踪个人 `AGENTS.md`、命名人设库或聊天记忆。
