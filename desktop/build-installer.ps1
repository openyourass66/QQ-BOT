param([string]$TrustFile,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
$taskProjectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $TrustFile){$TrustFile=Join-Path $taskProjectRoot 'components/release-trust.json'}
$taskTrustPath=(Resolve-Path -LiteralPath $TrustFile).Path
if((Get-Item -LiteralPath $taskTrustPath).Length -gt 65536){throw '发行信任文件过大'}
if(-not $OutputDirectory){$OutputDirectory=$taskProjectRoot}
$taskOutputRoot=[IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($taskOutputRoot)
$taskFramework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$taskWpf=Join-Path $taskFramework 'WPF'
$taskReferences=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Xaml.dll')|ForEach-Object {'/reference:'+(Join-Path $taskFramework $_)}
$taskReferences+=@('PresentationFramework.dll','PresentationCore.dll','WindowsBase.dll')|ForEach-Object {'/reference:'+(Join-Path $taskWpf $_)}
foreach($taskEntry in @(@{Source='SetupView.cs';Output='WhaleSetup.exe'},@{Source='Launcher.cs';Output='WhaleLauncher.exe'})){
    & (Join-Path $taskFramework 'csc.exe') /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ('/out:'+(Join-Path $taskOutputRoot $taskEntry.Output)) ('/win32manifest:'+(Join-Path $PSScriptRoot 'installer.manifest')) ('/win32icon:'+(Join-Path $PSScriptRoot 'assets/whale.ico')) ('/resource:'+$taskTrustPath+',release-trust.json') @taskReferences (Join-Path $PSScriptRoot 'ReleaseTrust.cs') (Join-Path $PSScriptRoot $taskEntry.Source)
    if($LASTEXITCODE -ne 0){throw '安装工具编译失败'}
}
Write-Output '安装工具与稳定启动器编译完成'
