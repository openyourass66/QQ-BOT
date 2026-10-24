param([switch]$Shortcut)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$wpf = Join-Path $framework 'WPF'
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'System.Xaml.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$references += @('PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path $wpf $_) }
$output = Join-Path $projectRoot 'QQ-BOT.exe'
& (Join-Path $framework 'csc.exe') /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/out:$output" @references (Join-Path $PSScriptRoot 'App.cs')
if ($LASTEXITCODE -ne 0) { throw '桌面端编译失败' }
if ($Shortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '小鲸机器人.lnk'))
    $link.TargetPath = $output
    $link.WorkingDirectory = $projectRoot
    $link.Save()
}
Write-Output "桌面端已生成：$output"
