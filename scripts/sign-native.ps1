param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$Thumbprint,[Parameter(Mandatory=$true)][string]$TimestampServer)
$ErrorActionPreference='Stop'
if($Thumbprint -notmatch '^[a-fA-F0-9]{40}$'){throw '代码签名证书指纹无效'}
$taskTimestamp=[Uri]$TimestampServer
if(-not $taskTimestamp.IsAbsoluteUri -or $taskTimestamp.Scheme -ne 'https' -or $taskTimestamp.UserInfo -or $taskTimestamp.Fragment){throw '请指定证书服务商提供的 HTTPS 时间戳服务'}
$taskCertificate=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$Thumbprint)
if(-not $taskCertificate.HasPrivateKey -or $taskCertificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow){throw '当前用户缺少可用的代码签名私钥或证书已经过期'}
$taskSdkRoot=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$taskSignTool=Get-ChildItem -Path (Join-Path $taskSdkRoot '*/x64/signtool.exe') -File -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if(-not $taskSignTool){throw '正式程序签名需要 Windows SDK 中的 x64 SignTool，请先安装对应组件'}
foreach($taskName in @('QQ-BOT.exe','WhaleSetup.exe','WhaleLauncher.exe','desktop/runtime-guard.exe','desktop/media-cleaner.exe')){
    $taskFile=[IO.Path]::GetFullPath((Join-Path $Directory $taskName))
    & $taskSignTool.FullName sign /sha1 $Thumbprint /fd SHA256 /tr $TimestampServer /td SHA256 $taskFile
    if($LASTEXITCODE -ne 0){throw '程序发布者签名失败，发行构建已停止'}
    $taskSignature=Get-AuthenticodeSignature -FilePath ([Management.Automation.WildcardPattern]::Escape($taskFile))
    if($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Thumbprint -ne $taskCertificate.Thumbprint){throw '程序发布者签名校验未通过，发行构建已停止'}
}
Write-Output '应用原生文件的发布者签名检查通过；固定 Node 官方文件未改写'
