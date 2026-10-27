param([switch]$Shortcut, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$wpf = Join-Path $framework 'WPF'
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'System.Xaml.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$references += @('PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path $wpf $_) }
$output = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $projectRoot 'QQ-BOT.exe' }
& (Join-Path $PSScriptRoot 'build-icon.ps1')
$iconPath = Join-Path $PSScriptRoot 'assets/whale.ico'
& (Join-Path $framework 'csc.exe') /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/out:$output" "/win32icon:$iconPath" "/resource:$iconPath,whale.ico" @references (Join-Path $PSScriptRoot 'App.cs') (Join-Path $PSScriptRoot 'SettingsView.cs') (Join-Path $PSScriptRoot 'RuntimeView.cs') (Join-Path $PSScriptRoot 'QuickSetupView.cs') (Join-Path $PSScriptRoot 'ComponentView.cs') (Join-Path $PSScriptRoot 'ActivityView.cs') (Join-Path $PSScriptRoot 'KnowledgeView.cs') (Join-Path $PSScriptRoot 'NativeTray.cs')
if ($LASTEXITCODE -ne 0) { throw '桌面端编译失败' }
# A low-integrity workspace must not lower the desktop app or its Node children.
& icacls.exe $output /setintegritylevel Medium | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法设置桌面程序的普通用户完整性级别，请检查生成文件权限' }
if ($Shortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '小鲸机器人.lnk'))
    $link.TargetPath = $output
    $link.WorkingDirectory = $projectRoot
    $link.Save()
}
Write-Output "桌面端已生成：$output"
