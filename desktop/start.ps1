$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$app = Join-Path $projectRoot 'QQ-BOT.exe'
if (![IO.File]::Exists($app)) {
    Push-Location $projectRoot
    try { & npm.cmd run desktop:build; if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' } }
    finally { Pop-Location }
}
Start-Process -FilePath $app -WorkingDirectory $projectRoot -WindowStyle Hidden
