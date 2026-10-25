# 开发与维护

## 模块边界

`src/bridge.ts` 与 `src/mcp-qq.ts` 保留稳定入口。内部模块按职责划分：

| 目录 | 主要模块 | 职责 |
| --- | --- | --- |
| `core/` | config、settings、runtime、store、usage、permissions | 配置、队列、会话映射、额度、审批及消息通用处理 |
| `qq/` | onebot、group-context、qq-actions、social-engine、social-store、social-tools、social-admin | 协议、QQ 行为、存档、工具定义与管理操作 |
| `agent/` | chat-model、cognition、learning-model、autonomy、context-policy | 模型连接、资料整理、群内用语、自主决策与上下文预算 |
| `services/` | media、web-service、action-server、action-client | 媒体与静态网页处理、桥接与 MCP 的内部通信 |

MCP 工具通过内部动作接口交由桥接执行；权限、会话范围、额度与轮次状态在执行处再次核验。桌面 Node 辅助模块使用 `dist/` 内对应目录的编译模块。改动路径时需同步测试、动态导入和桌面引用。

网页只需要静态 DOM 与正文提取，使用 [LinkeDOM](https://github.com/WebReflection/linkedom) 和 [Readability](https://github.com/mozilla/readability)。未包含完整浏览器模拟器；网页脚本与外部资源不执行、不加载。

## 构建与测试

```powershell
npm ci
npm run setup
npm run typecheck
npm test
```

`scripts/build.mjs` 使用项目锁定的 TypeScript 编译器。编译错误时不生成新输出；成功后仅清理没有对应源文件的 `.js`、`.js.map` 和空目录，保留其他文件。保留调试映射以便排障。构建和测试都不需要真实 QQ、模型或搜索凭据。

自动测试覆盖队列、OneBot HTTP/WS、ACP/MCP 进程、权限与额度、群上下文、表情收藏、提醒、自主行为、媒体、记忆迁移与整理、用语确认、搜索与正文、桌面配置保存。测试使用临时目录和受控服务，不会向真实 QQ 发消息或调用付费模型。

Windows 原生窗口验证：

```powershell
# 退出正在运行的工作台后构建
npm run desktop:build
powershell -NoProfile -ExecutionPolicy Bypass -File tests/desktop-smoke.ps1
```

`-SkipTrayCheck` 只跳过交互托盘检查，继续验证窗口与配置控件。没有交互桌面的环境不应把跳过的托盘测试记为通过。测试会打印隔离工作区位置，供检查界面截图。

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
