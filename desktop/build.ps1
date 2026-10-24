param([switch]$Shortcut, [switch]$Portable)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $projectRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '后端构建失败' }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $output = Join-Path $projectRoot 'QQ-BOT.exe'
    Add-Type -AssemblyName System.Drawing
    $bitmap = [Drawing.Bitmap]::new(64, 64)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = 'AntiAlias'
    $blue = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#4D79EF'))
    $light = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#BFD9FF'))
    $eye = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#203C79'))
    $tail = [Drawing.Drawing2D.GraphicsPath]::new()
    $tail.AddBezier(42, 30, 56, 33, 49, 15, 61, 15)
    $tail.AddBezier(61, 15, 59, 28, 69, 38, 46, 46)
    $tail.CloseFigure()
    $graphics.FillPath($blue, $tail)
    $graphics.FillEllipse($blue, 3, 17, 48, 37)
    $graphics.FillEllipse($light, 10, 40, 34, 11)
    $graphics.FillEllipse($blue, 7, 24, 39, 24)
    $graphics.FillEllipse($eye, 13, 30, 4, 5)
    $graphics.FillEllipse([Drawing.Brushes]::White, 14, 30, 2, 2)
    $graphics.FillEllipse($light, 24, 6, 5, 9)
    $graphics.FillEllipse($light, 31, 8, 5, 7)
    $iconPath = Join-Path $projectRoot 'QQ-BOT.ico'
    $handle = $bitmap.GetHicon()
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WhaleIconNative { [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle); }'
    $icon = [Drawing.Icon]::FromHandle($handle)
    $stream = [IO.File]::Create($iconPath)
    try { $icon.Save($stream) } finally {
        $stream.Dispose(); $icon.Dispose(); [void][WhaleIconNative]::DestroyIcon($handle)
        $tail.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $blue.Dispose(); $light.Dispose(); $eye.Dispose()
    }
    & $compiler /nologo /target:winexe /reference:System.Windows.Forms.dll "/win32icon:$iconPath" "/out:$output" (Join-Path $PSScriptRoot 'Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw '桌面入口构建失败' }
    if ($Shortcut) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'QQ-BOT.lnk'))
        $link.TargetPath = $output
        $link.WorkingDirectory = $projectRoot
        $link.Description = '小鲸鱼 · QQ 机器人桌面控制台'
        $link.Save()
    }
    if ($Portable) {
        $destination = Join-Path $projectRoot 'release/QQ-BOT'
        [void][IO.Directory]::CreateDirectory($destination)
        foreach ($name in @('desktop', 'dist', 'node_modules')) {
            Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $destination -Recurse -Force
        }
        foreach ($name in @('QQ-BOT.exe', 'QQ-BOT.ico', 'package.json', '.env.example')) {
            Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $destination -Force
        }
        [void][IO.Directory]::CreateDirectory((Join-Path $destination 'runtime'))
        Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $destination 'runtime/node.exe') -Force
        Write-Output "便携目录已生成（自带 Node，不含本地凭据）：$destination"
    }
    Write-Output "桌面入口已生成：$output"
} finally { Pop-Location }
