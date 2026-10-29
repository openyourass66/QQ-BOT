# 依赖安全修复记录

检查日期：2026-10-27。范围为项目生产依赖与固定 DSH 组件的 npm 依赖树；这不包含 QQ 原生二进制的安全审计，也不能替代工具权限和操作系统隔离。

主项目将 Zod 从 3 升级到固定的 4.6.7，并调整记录类型和对象默认值的解析方式，保留旧配置中省略字段的行为。新增超长集合提前拒绝测试，避免在已超出数量限制时继续逐项解析。

DSH 保留 0.2.1-rc.2，使用可复核的依赖覆盖与锁文件固定以下修复版本：

| 依赖 | 固定版本 | 修复依据 |
| --- | --- | --- |
| zod | 4.6.7 | [受限集合验证的资源耗尽](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) |
| @modelcontextprotocol/client | 2.3.0 | [跨来源重定向转发凭据和请求内容](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) |
| fflate | 0.8.3 | [异常 ZIP64 导致无限循环](https://github.com/advisories/GHSA-px8p-9vwx-vf98) |
| undici | 8.12.2 | [EventSource 解析器内存无界增长](https://github.com/advisories/GHSA-4qv8-2p9j-2685)及同批 HTTP 客户端修复 |

覆盖只作用于固定组件的安装清单，不修改用户自行维护的 DSH。安装仍从官方 npm 获取，检查 SRI 与清单摘要，并在切换活动版本前执行版本、ACP 初始化与实际 MCP 工具发现检查；探测不调用 QQ 工具或模型。旧受管路径可被修复结果识别，修复不重置已有 DSH Home。

当日使用官方 npm 的生产审计，主项目和 DSH 清单均为零已知告警。审计结果随公告变化；构建或升级时应重新执行：

```sh
npm audit --omit=dev --registry=https://registry.npmjs.org
npm --prefix components/dsh audit --omit=dev --registry=https://registry.npmjs.org
```

自动回归与实际组件兼容性检查的结果见[实施进展](implementation-status.md)。旧内部 ZIP 不会自动获得此修复，应重新构建发行目录；运行中的旧组件也不会被安装清单静默替换。
