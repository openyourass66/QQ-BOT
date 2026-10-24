$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('qq-desktop-ui-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
try {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'QQ-BOT.exe') -Destination $testRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot 'desktop') -Destination $testRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $testRoot -Recurse
    # Resolve the existing dependency tree without copying runtime data or credentials.
    [IO.File]::WriteAllText((Join-Path $testRoot '.env'), "BOT_WORKSPACE=$($testRoot.Replace('\', '/'))`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $testRoot 'AGENTS.md'), ([string][char]0x6D4B + [char]0x8BD5 + [char]0x5C0F + [char]0x9CB8 + [char]0x4EBA + [char]0x8BBE), [Text.UTF8Encoding]::new($false))
    # Use the installed dependencies while keeping settings and persona isolated.
    New-Item -ItemType Junction -Path (Join-Path $testRoot 'node_modules') -Target (Join-Path $projectRoot 'node_modules') | Out-Null
    $process = Start-Process -FilePath (Join-Path $testRoot 'QQ-BOT.exe') -ArgumentList '--smoke' -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(30000)) { throw 'Native UI smoke timed out' }
    $result = [IO.File]::ReadAllText((Join-Path $testRoot 'smoke-result.txt'))
    if ($process.ExitCode -ne 0 -or !$result.StartsWith('PASS:')) { throw $result }
    Write-Output $result
} finally {
    # The generated isolated directory is retained for inspection; it contains no real credentials.
    Write-Output "UI smoke workspace: $testRoot"
}
