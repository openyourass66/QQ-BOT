# 安装、手动升级与回退

适用 Windows 10/11 x64、一个普通 Windows 用户、一个数据实例。安装工具为完整发行包中的 `WhaleSetup.exe`，使用包内 Node 与 .NET Framework 4.8，无需系统 Node、npm 或管理员权限。须保留完整解压目录，不能单独复制安装 EXE。未签名的内部 ZIP 可便携试用，不能绕过信任校验执行安装升级。

## 使用流程

1. 完整解压受信发行 ZIP，双击 `WhaleSetup.exe`。已安装用户也可在数据维护窗口选择“安装、升级与回退”，退出工作台后打开工具。
2. 先从托盘退出使用相同数据的工作台。只关闭主窗口会进入托盘，仍占有实例锁；安装工具会拒绝这种情况，不结束其它进程或外部 OneBot。
3. 选择完整新发行目录、专用程序目录和原数据目录。默认程序目录为 `%LOCALAPPDATA%/Programs/WhaleWorkbench`，数据目录为 `%LOCALAPPDATA%/WhaleWorkbench`；两者不能互相包含。源码用户保留原项目为数据目录时，程序须安装到独立位置。
4. 已有数据时输入并确认 12–512 字符的恢复点密码；首次安装到真正的空实例可留空。升级恢复点保存为数据目录下 `backups/install-....wwbackup`，密码不会出现在命令行或日志中。忘记密码无法使用该恢复点。
5. 点击“安装或升级”。工具先验证编译时固定的发布公钥、发行签名与全部文件，再复制至独立版本目录并重新校验；保存当前数据恢复点，执行只读启动检查，成功后才切换活动版本。不启动 QQ，不调用模型，不发消息。
6. 成功后从开始菜单“小鲸工作台”或程序目录中的 `WhaleLauncher.exe` 启动。启动器依据安装记录选择活动版本并校验来源，显式传入原数据目录；程序还会注册到当前用户的 Windows 应用卸载列表。

更改程序目录不搬迁数据。现有安装绑定原数据路径，升级时不会静默切到另一个实例。DPAPI 密钥仍属于原 Windows 用户，备份不包含 QQ / DSH 登录态。

## 修复、回退与中断

“修复当前版本”要求选择相同版本、相同来源提交的完整包，重新建立经验证的程序目录；不清空配置或账号资料。

“回退上一版本”只在数据与升级时的指纹一致、旧程序仍可验证、配对加密恢复点未变且密码正确时执行。此时原数据本身已经与升级前一致，不重复覆盖数据库。新程序已经启动写入、人工编辑或其它工具改变了数据时，拒绝旧快照自动覆盖；先保留新数据，核对后再决定导出或使用明确的数据恢复流程。不能把不兼容数据库直接交给旧版。

安装工具或宿主进程在切换期间退出后，保留安装记录和数据目录中的 `.upgrade-journal.json`；业务启动与配置补建被阻止。使用原完整包的安装工具，选择相同程序/数据目录，再点击“处理上次中断”：未提交的切换撤回原程序指针，已提交的切换仅收尾；人工改变的数据保留并要求核对。不要手工删除中断记录强行启动。磁盘断电仍需单独验收，进程强退回归不代替断电证明。

旧版本与未激活暂存目录保留，最多允许 20 个版本目录；达到上限会停止继续复制，需核对专用程序目录。首发不提供自动轮转或后台删除历史程序。

## 卸载与数据保留

选择“卸载程序，保留数据”，或从 Windows 应用卸载列表进入。安装目录内的工具会先准备独立副本，避免运行中的安装器或 Node 阻止删除。卸载验证程序归属，只移除能够核验的程序文件与当前用户入口；配置、凭据、聊天、QQ 登录和加密备份保留在独立数据目录。

无法确认、已经被修改或仍被占用的历史文件保留在程序目录的 `.retired-...` 下，窗口显示位置，不通过递归强删冒险移除用户资料。少量卸载归属记录和恢复入口保留，供重试或再次安装识别。删除用户数据须另行明确选择，不属于卸载默认行为。

## 签名与构建

`components/release-trust.json` 保存发布公钥；源码默认不附带正式发布身份。发行清单为 `release-integrity.json` 与独立签名文件，RSA 至少 3072 位、SHA-256；原生安装器与稳定启动器嵌入相同公钥，在执行 Node 之前核对全部文件。Node 与 .NET 的相应签名接口见 [Node crypto](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback)和 [Microsoft RSA 验证接口](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.rsacryptoserviceprovider.verifydata)。

内部验证可以在被忽略的本地目录生成临时密钥。该密钥只允许 `internal-validation` 通道，不代表正式发布者身份，不能通过 G01–G06；不同内部构建若更换公钥，不能直接互相升级。更新包须保留当前公钥以支持失败回退。正式发布须固定公钥、保护私钥并在切换前落实签名材料。

```powershell
node scripts/dev/internal-signing-key.mjs --directory release/cache/internal-signing
npm run desktop:build
node scripts/package.mjs --output release/WhaleWorkbench-preview --zip --signing-key release/cache/internal-signing/internal-signing.pem --key-id internal-validation --trust-file release/cache/internal-signing/internal-trust.json
```

正式通道还要求代码签名证书、HTTPS RFC 3161 时间戳和绑定当前代码输入树的实际验收记录。原生文件通过 Windows SDK 的 SignTool 签署并复核，固定 Node 官方二进制保持原样；方式依据 [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)。安装工具声明 `asInvoker`，不要求提升，见 [Windows 应用清单](https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests)。

`.github/workflows/release-internal.yml` 构建内部签名候选并执行原生检查；`release-stable.yml` 检查 G01–G06、正式清单密钥、证书和验收证据后才构建稳定通道，上传产物不自动公开发布。工作流 action 固定提交，运行库、npm 清单、组件摘要与许可沿用锁定来源。工作流存在不计为已经在远端通过，本轮未推送或触发远端构建。

正式工作流所需环境 secrets：`RELEASE_MANIFEST_PRIVATE_KEY_PEM`、`RELEASE_MANIFEST_KEY_ID`、`RELEASE_CODESIGN_PFX_BASE64`、`RELEASE_CODESIGN_PASSWORD` 和 `RELEASE_TIMESTAMP_SERVER`。私钥与 PFX 仅进入作业临时文件，最终删除，不放进源码、ZIP 或验证附件。
