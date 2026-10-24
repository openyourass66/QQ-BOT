param([string]$Executable = 'QQ-BOT.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('qq-desktop-ui-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
try {
    Copy-Item -LiteralPath (Join-Path $projectRoot $Executable) -Destination (Join-Path $testRoot 'QQ-BOT.exe')
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
    Add-Type -AssemblyName UIAutomationClient
    $automationRoot = [Windows.Automation.AutomationElement]::RootElement
    $interactive = Start-Process -FilePath (Join-Path $testRoot 'QQ-BOT.exe') -ArgumentList '--tray-check' -WindowStyle Hidden -PassThru
    $pidCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $interactive.Id)
    function Find-FixtureWindow {
        $automationRoot.FindFirst([Windows.Automation.TreeScope]::Children, $pidCondition)
    }
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    do { $fixtureWindow = Find-FixtureWindow; if (!$fixtureWindow) { Start-Sleep -Milliseconds 100 } } until ($fixtureWindow -or [datetime]::UtcNow -gt $deadline)
    if (!$fixtureWindow) { throw 'Fixture window did not open' }
    $fixtureWindow.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close()
    $trayTitle = 'Whale UI tray check'
    $trayCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $trayTitle)
    $trayElement = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $trayCondition)
    if (!$trayElement) {
        $overflowName = ([string][char]0x663E + [char]0x793A + [char]0x9690 + [char]0x85CF + [char]0x7684 + [char]0x56FE + [char]0x6807)
        $overflow = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $overflowName))
        for ($attempt=0; $attempt -lt 2 -and !$trayElement; $attempt++) {
            if ($overflow) { $overflow.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
            $deadline = [datetime]::UtcNow.AddSeconds(2)
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
    $quitCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'Tray-quit')
    do { $quitItem = $automationRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $quitCondition); if (!$quitItem) { Start-Sleep -Milliseconds 100 } } until ($quitItem -or [datetime]::UtcNow -gt $deadline)
    if (!$quitItem) { throw 'Tray exit menu item did not appear' }
    $quitItem.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    if (!$interactive.WaitForExit(10000)) { throw 'Fixture did not exit' }
    Write-Output 'PASS: Windows notification icon exists, actual tray invoke restores window, tray menu exits application'
} finally {
    if ($interactive -and !$interactive.HasExited) { Stop-Process -Id $interactive.Id }
    # The generated isolated directory is retained for inspection; it contains no real credentials.
    Write-Output "UI smoke workspace: $testRoot"
}
