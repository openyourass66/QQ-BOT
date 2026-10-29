# 组件准备与内部发行目录

当前支持 Windows x64 的个人、非商业验证。项目代码采用 MIT；下载的组件、QQ 运行文件和各依赖继续适用各自许可。此阶段生成的是内部验证目录，尚未通过完整 QQ 登录、权限隔离、升级迁移与连续运行验收。

2026-10-29 已生成 `WhaleWorkbench-0.2.0-win-x64-rc5`，来源提交 `a756d38`，包含本轮 SQLite、权限、运行管理、登录及停机清理代码。包内原生窗口首轮及一条真实 QQ 基础聊天链路通过，完整正式发布门槛仍待验收。详见[候选记录](validation/release-candidate-rc5-2026-10-29.json)。

## 在工作台准备组件

打开「快速配置 → 检测环境 → 准备运行组件」。模型运行器可下载并准备，QQ 接入组件还可导入已经下载的官方 ZIP。下载和导入使用同一份固定摘要校验，不接受其它版本、改名替换或校验失败的包。

准备过程显示下载量、解压、依赖安装和检查状态。可取消或关闭准备窗口；取消、校验失败、进程失败不会替换旧的活动组件。成功后只补全空白、默认或本次被替换的受管路径草稿，不自动保存配置，不覆盖用户新输入的自定义路径。模型与 QQ 实际登录仍按后续配置步骤完成。

安装时必须停止使用同一数据目录的桥接与受管 QQ 进程。桌面操作会先检查进程状态，组件工作进程还会获取业务数据资源锁及组件锁，防止命令行或另一份工作台绕过检查。取消消息独立于安装命令队列，退出工作台会取消正在准备的组件。

## 固定来源与版本

| 组件 | 固定版本 | 获取与校验 |
| --- | --- | --- |
| 应用及模型用 Node | 24.22.1 / Windows x64 | [官方 ZIP 与摘要](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)，固定长度与 SHA-256 |
| DSH | 0.2.1-rc.2 | [官方 npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.2)，完整依赖锁和逐包 SRI |
| NapCat | 4.18.41 / Windows Node 包 | [官方发行](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41)，固定长度及官方发行元数据中的 SHA-256 |

`components/catalog.json` 保存组件版本、大小、摘要和入口；`components/dsh/package-lock.json` 固定包括间接依赖在内的版本，不在用户安装时重新选择最新版。DSH 根清单自身也有摘要，安装命令固定使用官方 npm registry，并禁用生命周期脚本。子进程不继承项目密钥、DSH 会话、用户 npm 令牌和 `NODE_OPTIONS`，使用独立 npm 配置与临时目录。

依赖锁与上游许可的 Git 换行属性已固定，避免 Windows 检出时改变原始字节，使固定摘要失效；回归同时核对这两份输入。

发行目录已有固定 Node 时，先核对发行清单及官方 Node 二进制摘要，再复制内置环境供模型使用，避免重复联网下载 Node；源码模式没有内置环境时才获取官方包。

下载仅允许列明的 HTTPS 官方域名及必要的 GitHub 资源跳转；拒绝非官方跳转。无进展会超时，临时网络错误允许有限重试。每个 ZIP 先校验完整摘要，再逐项解压；限制条目、总大小和单文件大小，拒绝链接、特殊文件、Windows 保留名、路径越界、重复与大小写冲突。解压不覆盖已有目录。

版本先写入独立临时目录，检查入口、Node/DSH 版本及 DSH ACP 初始化后才切换 `components/active.json`。探测不发送模型提示词，也不复用用户的 DSH 登录目录。旧组件目录保留，自动回收和完整回退界面属于后续维护阶段。已准备状态只代表相应入口检查通过，不保证所有原生工具、真实 QQ、模型或网络能力可用。

清单摘要校验不等同于发行者签名；应用更新清单签名和 EXE 发布签名尚未实现，不应把此内部目录作为正式稳定发行。

## 数据与 QQ 入口

组件位于所选数据目录的 `components/<组件>/<版本>-<实例编号>/`。活动记录只保存受限格式的目录编号。下载缓存和临时 npm 文件在任务结束后清理；程序目录不存储用户登录或个人数据。

受管 DSH 使用独立 Node 24，生成的启动包装器通过相对路径引用它，便于整体移动数据目录。新配置建议的 DSH Home 位于数据目录的 `dsh/`；已有自定义目录与登录习惯保留。此处并未实现完整 DSH 工具沙箱。

固定依赖清单包含明确的安全修复覆盖，详见[依赖安全修复记录](dependency-security.md)。准备真实 DSH 时验证版本、ACP 初始化及与本项目 MCP 服务的工具发现兼容性，只列出 QQ 工具，不执行模型或 QQ 动作。清单变化会让旧收据失效；修复时仍识别旧受管路径供替换，不重置已有 DSH Home。命令行输出的路径建议需要用户自行保存，不自动修改环境文件。

官方 NapCat Node 包包含独立 Node 22.11.0、Shell、QQ 适配库和对应运行文件。受管 QQ 使用该包自己的 Node，不用它启动需要 SQLite 的应用桥接。工作目录及配置保存在稳定的 `napcat/node-runtime/`，组件版本目录承载运行文件。首次 WebUI 配置只绑定 `127.0.0.1` 并生成随机令牌；已有配置不覆盖。

选择受管包的 Shell 后不再要求系统 QQ 安装目录，原来的手工 Shell + QQ 安装目录模式仍保留。真实扫码、额外账号验证、OneBot 安全自动配置及登录状态展示尚待 D03 验收；本轮没有启动真实 QQ 账号。

## 构建内部验证目录

```powershell
npm ci
npm run package:dir
# 同时生成可分享的内部 ZIP；请选未使用过的输出目录
npm run package:dir -- --zip --output release/WhaleWorkbench-preview
```

默认输出 `release/WhaleWorkbench-0.2.0-win-x64/`。目录或同名 ZIP 存在时拒绝覆盖，可显式指定新的 `--output release/其它目录`；仅接受 `release` 的直接子目录，避免嵌套目录联接改变输出位置。可用 `--node-archive 官方ZIP路径` 导入固定 Node 包，校验规则相同。

构建要求发行输入已提交，清单记录源码提交与构建时间。发布目录形成前校验必需文件、静态/动态模块引用和生产依赖，拒绝遗漏的登录模块、工作进程、原生助手及个人数据。ZIP 使用标准 `/` 路径，失败时只清除本次暂存文件，完成后再不覆盖地发布；同时生成 `.zip.sha256`。该摘要用于文件一致性核对，不等同于正式发行签名，可信签名清单仍属于 V4。

构建只复制已编译业务、公开模板、桌面必需资源、组件清单、许可与脚本，并使用隔离的 npm 环境安装生产依赖。不会复制 `.env`、个人工作区、存档、QQ/DSH 登录状态或开发机的整个依赖目录。包内包含完整的固定 Node/npm、项目许可、依赖许可清单和使用说明；用户启动 EXE 不需要全局 Node、npm、Git 或编译工具。DSH 与 QQ 组件由用户在工作台发起准备，未随本包重复分发。

候选包增加 `开始使用.cmd`，解压到可写目录后双击，以便携模式将数据放在包旁的 `user-data`；启动器只为本次启动清除冲突的 `BOT_DATA_DIR` 环境值，不改变系统环境。直接运行 `QQ-BOT.exe` 仍使用普通模式。完整配置步骤与退出方式见包内 `使用说明.html`。使用后不要把含个人 `user-data` 的整个运行目录转发，分享时使用原始干净 ZIP。

高级命令：

```powershell
npm run components -- list --data-dir 'E:\机器人测试数据'
npm run components -- install dsh --data-dir 'E:\机器人测试数据'
npm run components -- install napcat --archive 'E:\下载\NapCat.Shell.Windows.Node.zip' --data-dir 'E:\机器人测试数据'
```

## 验证范围

自动回归覆盖下载校验、取消、重试、异常 ZIP、失败不切换、安装互斥、隔离环境、ACP 协议探测、桌面取消/退出和受管 QQ 路径。Windows 临时文件占用超过原重试窗口的场景也已验证；社交 JSON 替换采用有上限的重试，实例抢锁增加短暂退避，不绕过持锁进程。

原生验证命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/desktop-smoke.ps1 -SeparateData -SkipTrayCheck
powershell -NoProfile -ExecutionPolicy Bypass -File tests/desktop-smoke.ps1 -ReleaseDirectory release/WhaleWorkbench-0.2.0-win-x64 -SeparateData -SkipTrayCheck
```

第二条使用发行目录自身的依赖与 Node，并从测试进程 PATH 移除开发机 Node/npm，验证组件窗口、配置、人设、活动及窗口恢复。它使用假数据，不是干净 Windows 虚拟机验收；`-SkipTrayCheck` 未执行实际托盘点击。

本轮对 `rc4` 使用包内 Node 和生产依赖执行上述原生冒烟，包含托盘调用恢复/退出，首轮通过；真实独立实例由用户完成 QQ 官方登录并确认回复，数据库记录一条入站、一条回复和一轮无错误完成的对话。`rc5` 修正 ZIP 分隔符和来源记录，除发行清单及说明中的版本来源文字外，8087 个文件与已验证的 `rc4` 逐一摘要一致；没有把容器格式修正冒充重新执行全部真实业务验收。
