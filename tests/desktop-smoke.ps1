param([string]$Executable = 'QQ-BOT.exe', [switch]$SkipTrayCheck, [switch]$SeparateData, [string]$ReleaseDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('qq-desktop-ui-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$fixtureDataRoot = if ($SeparateData) { Join-Path $testRoot 'user data' } else { $testRoot }
[void][IO.Directory]::CreateDirectory($fixtureDataRoot)
function Start-Fixture([string[]]$LaunchArguments) {
    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $testRoot 'QQ-BOT.exe'), ($LaunchArguments -join ' '))
    $info.WorkingDirectory = $testRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $testRoot 'local appdata'
    $info.EnvironmentVariables.Remove('BOT_DATA_DIR')
    foreach ($key in @($info.EnvironmentVariables.Keys)) {
        if ($key -match '^(BOT_|ONEBOT_|QQ_BOT_|SESSION_STORE$|ADMIN_QQ$|ALLOW_EXEC$)') { $info.EnvironmentVariables.Remove($key) }
    }
    if ($ReleaseDirectory) { $info.EnvironmentVariables['PATH'] = (Join-Path $env:WINDIR 'System32') + ';' + (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0') }
    return [Diagnostics.Process]::Start($info)
}
try {
    $executablePath = if ([IO.Path]::IsPathRooted($Executable)) { $Executable } else { Join-Path $projectRoot $Executable }
    if ($ReleaseDirectory) {
        foreach ($entry in Get-ChildItem -LiteralPath ([IO.Path]::GetFullPath($ReleaseDirectory)) -Force) { Copy-Item -LiteralPath $entry.FullName -Destination $testRoot -Recurse }
    } else {
    Copy-Item -LiteralPath $executablePath -Destination (Join-Path $testRoot 'QQ-BOT.exe')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'desktop') -Destination $testRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $testRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $testRoot
    [void][IO.Directory]::CreateDirectory((Join-Path $testRoot 'scripts'))
    Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/setup.mjs') -Destination (Join-Path $testRoot 'scripts/setup.mjs')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/app-paths.mjs') -Destination (Join-Path $testRoot 'scripts/app-paths.mjs')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/component-paths.mjs') -Destination (Join-Path $testRoot 'scripts/component-paths.mjs')
    }
    if ($SeparateData -and !$ReleaseDirectory) {
        Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $testRoot
        Copy-Item -LiteralPath (Join-Path $projectRoot 'templates') -Destination $testRoot -Recurse
        [void][IO.Directory]::CreateDirectory((Join-Path $testRoot 'runtime'))
        Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $testRoot 'runtime/node.exe')
        [IO.File]::WriteAllText((Join-Path $testRoot 'release-manifest.json'), '{"formatVersion":1,"appId":"whale-workbench","version":"0.2.0"}', [Text.UTF8Encoding]::new($false))
    }
    # Resolve the existing dependency tree without copying runtime data or credentials.
    [IO.File]::WriteAllText((Join-Path $fixtureDataRoot '.env'), "BOT_WORKSPACE=$($fixtureDataRoot.Replace('\', '/'))`nONEBOT_HTTP_URL=http://127.0.0.1:1`nONEBOT_WS_URL=ws://127.0.0.1:1`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureDataRoot 'AGENTS.md'), ([string][char]0x6D4B + [char]0x8BD5 + [char]0x5C0F + [char]0x9CB8 + [char]0x4EBA + [char]0x8BBE), [Text.UTF8Encoding]::new($false))
    foreach ($fixtureDirectory in @('.whale', 'memory', 'data')) { [void][IO.Directory]::CreateDirectory((Join-Path $fixtureDataRoot $fixtureDirectory)) }
    $fixturePersonas = @{ version = 1; personas = @(@{ id = 'preset-friendly'; name = 'Friendly'; text = 'Speak warmly and briefly.'; updatedAt = 1 }, @{ id = 'preset-work'; name = 'Work'; text = 'Answer precisely.'; updatedAt = 1 }) } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $fixtureDataRoot '.whale/personas.json'), $fixturePersonas, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureDataRoot 'memory/notes.md'), 'Remember the fixture workspace.', [Text.UTF8Encoding]::new($false))
    $fixtureStickers = @(
        @{ id = 'pending-sticker'; file = ''; note = 'Local pending sticker'; tags = @(); uses = 0; at = 1 },
        @{ id = 'qq-sticker'; file = ''; note = 'QQ favorite sticker'; tags = @(); uses = 0; at = 1; qqPresent = $true; md5 = ('a' * 32); qq = @{ resId = 'fixture-resource'; emojiId = '7'; md5 = ('a' * 32); url = ''; cachePath = ''; description = 'QQ favorite' } }
    )
    $fixtureNow = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $fixtureAutonomous = @{ interests = @(@{ id = 'interest-fixture'; chat = ''; topic = 'Cat stickers'; reason = 'Public creative interest'; strength = 3; source = 'admin'; at = $fixtureNow; updatedAt = $fixtureNow }); thoughts = @(@{ id = 'thought-fixture'; key = 'fixture'; chat = 'private:10001'; kind = 'chat'; summary = 'Continue the topic later'; reason = 'An unfinished conversation'; at = $fixtureNow; due = ($fixtureNow + 3600000); expires = ($fixtureNow + 86400000); priority = 50; state = 'pending'; result = '' }); decisions = @(@{ id = 'decision-fixture'; thoughtId = 'previous'; chat = ''; kind = 'qzone'; at = $fixtureNow; outcome = 'dismissed'; reason = 'Nothing worth publishing yet' }) }
    $fixtureCognition = @{ lexicon = @(@{ id = 'lexicon-fixture'; chat = 'group:30001'; term = 'Clock out'; meaning = 'Finish the game'; kind = 'term'; sources = @(1, 2, 3); status = 'candidate'; locked = $false; revision = 1; at = $fixtureNow; history = @() }) }
    $fixtureSocial = @{ version = 1; account = 0; messages = @(); contacts = @(); memories = @(@{ id = 'memory-fixture'; chat = 'private:10001'; user = '10001'; name = 'Fixture friend'; text = 'Does not drink coffee.'; at = 1 }); stickers = $fixtureStickers; tasks = @(); events = @(); actions = @(); turns = @(); profiles = @(); autonomous = $fixtureAutonomous; cognition = $fixtureCognition } | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText((Join-Path $fixtureDataRoot 'data/social.json'), $fixtureSocial, [Text.UTF8Encoding]::new($false))
    # Use the installed dependencies while keeping settings and persona isolated.
    if (!$ReleaseDirectory) { New-Item -ItemType Junction -Path (Join-Path $testRoot 'node_modules') -Target (Join-Path $projectRoot 'node_modules') | Out-Null }
    $fixtureNode = if (Test-Path -LiteralPath (Join-Path $testRoot 'runtime/node.exe')) { Join-Path $testRoot 'runtime/node.exe' } else { (Get-Command node.exe).Source }
    Push-Location $testRoot
    try {
        & $fixtureNode --input-type=module -e "import QR from 'qrcode';import {writeFile} from 'node:fs/promises';await writeFile('qq-login-qr.txt',await QR.toDataURL('https://qq.com/fixture-no-login',{width:256,margin:2}));"
        if ($LASTEXITCODE -ne 0) { throw 'Fixture QR generation failed' }
    } finally { Pop-Location }
    $smokeArguments = if ($SeparateData) { @('--smoke', '--data-dir', ('"' + $fixtureDataRoot + '"')) } else { @('--smoke') }
    $process = Start-Fixture $smokeArguments
    if (!$process.WaitForExit(30000)) { throw 'Native UI smoke timed out' }
    $result = [IO.File]::ReadAllText((Join-Path $testRoot 'smoke-result.txt'))
    if ($process.ExitCode -ne 0 -or !$result.StartsWith('PASS:')) { throw $result }
    Write-Output $result
    if ($SeparateData) {
        foreach ($name in @('.env', 'bot.config.json', 'data', 'napcat', '.whale', 'memory')) {
            if (Test-Path -LiteralPath (Join-Path $testRoot $name)) { throw "Personal data unexpectedly written under program directory: $name" }
        }
        Write-Output 'PASS: bundled Node, release layout and separate data directory with spaces'
    }
    if ($SkipTrayCheck) { return }
    Add-Type -AssemblyName UIAutomationClient
    $automationRoot = [Windows.Automation.AutomationElement]::RootElement
    $trayArguments = if ($SeparateData) { @('--tray-check', '--data-dir', ('"' + $fixtureDataRoot + '"')) } else { @('--tray-check') }
    $interactive = Start-Fixture $trayArguments
    $pidCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $interactive.Id)
    $fixtureCondition = [Windows.Automation.AndCondition]::new($pidCondition, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window))
    function Find-FixtureWindow {
        $automationRoot.FindFirst([Windows.Automation.TreeScope]::Children, $fixtureCondition)
    }
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    do { $fixtureWindow = Find-FixtureWindow; if (!$fixtureWindow) { Start-Sleep -Milliseconds 100 } } until ($fixtureWindow -or [datetime]::UtcNow -gt $deadline)
    if (!$fixtureWindow) { throw 'Fixture window did not open' }
    $fixtureWindow.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close()
    $trayTitle = 'Whale UI tray check ' + [IO.Path]::GetFileName($testRoot)
    $trayCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $trayTitle)
    $trayElement = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $trayCondition)
    if (!$trayElement) {
        $overflowName = ([string][char]0x663E + [char]0x793A + [char]0x9690 + [char]0x85CF + [char]0x7684 + [char]0x56FE + [char]0x6807)
        $overflow = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $overflowName))
        for ($attempt=0; $attempt -lt 3 -and !$trayElement; $attempt++) {
            if ($overflow) { $overflow.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
            $deadline = [datetime]::UtcNow.AddSeconds(3)
            do { $trayElement = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $trayCondition); if (!$trayElement) { Start-Sleep -Milliseconds 100 } } until ($trayElement -or [datetime]::UtcNow -gt $deadline)
        }
    }
    if (!$trayElement) { throw 'Native notification icon is missing from the Windows tray' }
    $trayElement.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    $deadline = [datetime]::UtcNow.AddSeconds(5)
    do { $fixtureWindow = Find-FixtureWindow; if (!$fixtureWindow) { Start-Sleep -Milliseconds 100 } } until ($fixtureWindow -or [datetime]::UtcNow -gt $deadline)
    if (!$fixtureWindow) { throw 'Clicking the native tray icon did not restore the window' }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TraySmokeMessages { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam); }'
    # Route the existing tray context-menu callback, then invoke its real exit command.
    [void][TraySmokeMessages]::PostMessage([IntPtr]$fixtureWindow.Current.NativeWindowHandle, 0x800B, [IntPtr]::Zero, [IntPtr]0x7B)
    $deadline = [datetime]::UtcNow.AddSeconds(5)
    $quitCondition = [Windows.Automation.AndCondition]::new($pidCondition, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'Tray-quit'))
    do { $quitItem = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $quitCondition); if (!$quitItem) { Start-Sleep -Milliseconds 100 } } until ($quitItem -or [datetime]::UtcNow -gt $deadline)
    if (!$quitItem) { throw 'Tray exit menu item did not appear' }
    $quitItem.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    if (!$interactive.WaitForExit(10000)) { throw 'Fixture did not exit' }
    Write-Output 'PASS: Windows notification icon exists, actual tray invoke restores window, tray menu exits application'
} finally {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id }
    if ($interactive -and !$interactive.HasExited) { Stop-Process -Id $interactive.Id }
    # The generated isolated directory is retained for inspection; it contains no real credentials.
    Write-Output "UI smoke workspace: $testRoot"
}
