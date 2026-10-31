param(
    [string]$ServerHost = '192.168.150.104',
    [int]$ServerPort = 22,
    [string]$ServerUser = 'whalecheck',
    [string]$KeyFile = 'D:\CentOS7\Whale-Ubuntu-24.04-Test\whalecheck_ed25519',
    [string]$RemoteNode = '/opt/whale/node-v24.22.1-linux-x64/bin/node',
    [string]$RemoteProgram = '/home/whalecheck/QQ-BOT-upgrade',
    [string]$RemoteData = '/home/whalecheck/whale-data',
    [string]$Executable = 'QQ-BOT.exe',
    [switch]$SkipServerRestart
)

# 阶段 3 验收：用真实桌面控制台通过 SSH 连接虚拟机守护进程。
# 本脚本不会点击“退出并停止机器人”，因此服务器上的机器人始终保持运行。

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('qq-desktop-remote-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Invoke-Ssh([string]$command) {
    $output = & ssh -i $KeyFile -o BatchMode=yes -o StrictHostKeyChecking=no -o LogLevel=ERROR -o ConnectTimeout=8 -p $ServerPort "$ServerUser@$ServerHost" $command 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SSH 命令失败：$command`n$($output -join "`n")" }
    return ($output -join "`n")
}

function Start-Fixture([string]$dataDir) {
    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $testRoot 'QQ-BOT.exe'), ('--data-dir "' + $dataDir + '"'))
    $info.WorkingDirectory = $testRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $testRoot 'local appdata'
    $info.EnvironmentVariables.Remove('BOT_DATA_DIR')
    foreach ($key in @($info.EnvironmentVariables.Keys)) {
        if ($key -match '^(BOT_|ONEBOT_|QQ_BOT_|SESSION_STORE$|ADMIN_QQ$|ALLOW_EXEC$)') { $info.EnvironmentVariables.Remove($key) }
    }
    return [Diagnostics.Process]::Start($info)
}

function Stop-Fixture($process) {
    if ($process -and !$process.HasExited) { & taskkill.exe /T /F /PID $process.Id | Out-Null }
}

$uiRoot = [Windows.Automation.AutomationElement]::RootElement
function Find-WithId([int]$appPid, [string]$automationId, [int]$timeoutMs = 10000) {
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $appPid),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId))
    $deadline = [datetime]::UtcNow.AddMilliseconds($timeoutMs)
    do {
        $element = $uiRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if ($element) { return $element }
        Start-Sleep -Milliseconds 120
    } until ([datetime]::UtcNow -gt $deadline)
    return $null
}

function Wait-Text([int]$appPid, [string]$automationId, [string]$pattern, [int]$timeoutSeconds = 30) {
    $deadline = [datetime]::UtcNow.AddSeconds($timeoutSeconds)
    $last = ''
    do {
        $element = Find-WithId $appPid $automationId 300
        if ($element) { $last = $element.Current.Name; if ($last -match $pattern) { return $last } }
        Start-Sleep -Milliseconds 150
    } until ([datetime]::UtcNow -gt $deadline)
    throw "等待 $automationId 匹配 /$pattern/ 超时（最后值：$last）"
}

function Select-Tab([int]$appPid, [string]$name) {
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $appPid),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name))
    $element = $uiRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if (!$element) { throw "找不到标签页 $name" }
    $element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
}

function Invoke-Button([int]$appPid, [string]$automationId) {
    $element = Find-WithId $appPid $automationId 8000
    if (!$element) { throw "找不到按钮 $automationId" }
    $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Get-ChildSsh([int]$appPid) {
    return @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=$appPid") | Where-Object { $_.Name -eq 'ssh.exe' })
}

try {
    Invoke-Ssh 'systemctl is-active whaled' | Out-Null
    $canRestart = $true
    try { Invoke-Ssh 'sudo -n true' | Out-Null } catch { $canRestart = $false }

    # 生成主机密钥记录，与桌面端 ssh 抓取格式一致。
    $knownHostsTemp = Join-Path $testRoot 'scan-known-hosts'
    & ssh -T -i $KeyFile -o BatchMode=yes -o LogLevel=ERROR -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o GlobalKnownHostsFile=NUL -o UpdateHostKeys=no -o "UserKnownHostsFile=$knownHostsTemp" -p $ServerPort "$ServerUser@$ServerHost" true 2>&1 | Out-Null
    if (!(Test-Path -LiteralPath $knownHostsTemp)) { throw '无法抓取服务器主机密钥' }
    $knownParts = @(Get-Content -LiteralPath $knownHostsTemp | Where-Object { $_.Trim().Length -gt 0 -and !$_.StartsWith('#') } | ForEach-Object {
        $parts = $_ -split '\s+', 3
        if ($parts.Length -lt 3) { throw "主机密钥行格式异常：$_" }
        $parts[1] + ' ' + $parts[2]
    })
    if ($knownParts.Count -eq 0) { throw '没有可用的主机密钥' }
    $fingerprint = (& ssh-keygen -lf $knownHostsTemp 2>$null) -join "`n"
    function Get-KnownLines([string]$hostName, [int]$port) {
        $token = if ($port -eq 22) { $hostName } else { '[' + $hostName + ']:' + $port }
        return @($knownParts | ForEach-Object { $token + ' ' + $_ })
    }

    # 复制桌面程序与本地依赖（与 desktop-smoke 相同的最小集合）。
    Copy-Item -LiteralPath (Join-Path $projectRoot $Executable) -Destination (Join-Path $testRoot 'QQ-BOT.exe')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'desktop') -Destination $testRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $testRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $testRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $testRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot 'templates') -Destination $testRoot -Recurse
    [void][IO.Directory]::CreateDirectory((Join-Path $testRoot 'scripts'))
    foreach ($name in @('setup.mjs', 'app-paths.mjs', 'component-paths.mjs', 'runtime-service.mjs', 'runtime-configuration.mjs', 'runtime-lease.mjs', 'credentials.mjs', 'env-file.mjs', 'process-guard.mjs', 'managed-entry.mjs', 'supervisor.mjs', 'bounded-lines.mjs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "scripts/$name") -Destination (Join-Path $testRoot 'scripts')
    }
    [void][IO.Directory]::CreateDirectory((Join-Path $testRoot 'runtime'))
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $testRoot 'runtime/node.exe')
    [IO.File]::WriteAllText((Join-Path $testRoot 'release-manifest.json'), '{"formatVersion":1,"appId":"whale-workbench","version":"0.2.0"}', [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Junction -Path (Join-Path $testRoot 'node_modules') -Target (Join-Path $projectRoot 'node_modules') | Out-Null

    function New-RemoteFixture([string]$name, [string]$hostName, [int]$port) {
        $dataDir = Join-Path $testRoot $name
        [void][IO.Directory]::CreateDirectory($dataDir)
        [void][IO.Directory]::CreateDirectory((Join-Path $dataDir 'remote'))
        [IO.File]::WriteAllText((Join-Path $dataDir '.env'), ("BOT_WORKSPACE=" + ($dataDir.Replace('\', '/')) + "`nONEBOT_HTTP_URL=http://127.0.0.1:1`nONEBOT_WS_URL=ws://127.0.0.1:1`n"), [Text.UTF8Encoding]::new($false))
        $profile = @{ Id = 'vm-fixture'; Name = 'VM 验收'; Host = $hostName; Port = $port; User = $ServerUser; KeyFile = $KeyFile; Node = $RemoteNode; Program = $RemoteProgram; DataDir = $RemoteData; Fingerprint = $fingerprint }
        $config = @{ Version = 1; Mode = 'remote'; Active = 'vm-fixture'; Profiles = @($profile) }
        [IO.File]::WriteAllText((Join-Path $dataDir 'remote/connections.json'), ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllLines((Join-Path $dataDir 'remote/known_hosts'), (Get-KnownLines $hostName $port), [Text.UTF8Encoding]::new($false))
        return $dataDir
    }

    $primary = New-RemoteFixture 'console-one' $ServerHost $ServerPort
    $secondary = New-RemoteFixture 'console-two' $ServerHost $ServerPort
    $blackhole = New-RemoteFixture 'console-cancel' '192.0.2.1' 22

    $one = Start-Fixture $primary
    try {
        [void](Find-WithId $one.Id 'ServerState' 20000)
        $serverState = Wait-Text $one.Id 'ServerState' '已连接服务器' 40
        Write-Output "PASS: 远程控制台已连接服务器（$serverState）"

        $daemon = Invoke-Ssh ('systemctl is-active whaled; test -S ' + $RemoteData + '/run/whaled.sock && echo SOCKET_OK')
        if ($daemon -notmatch 'active' -or $daemon -notmatch 'SOCKET_OK') { throw "服务器守护进程状态异常：$daemon" }
        Select-Tab $one.Id '工作总览'
        [void](Wait-Text $one.Id 'State' '\S' 20)
        Select-Tab $one.Id '连接与运行'
        Write-Output 'PASS: 服务器保持守护进程与机器人运行'

        # 断开连接：桌面端停止转发，服务器机器人继续运行。
        Invoke-Button $one.Id 'ServerConnection'
        Invoke-Button $one.Id 'Connection-Disconnect'
        [void](Wait-Text $one.Id 'ServerState' '已断开' 15)
        Start-Sleep -Milliseconds 800
        if ((Get-ChildSsh $one.Id).Count -ne 0) { throw '断开后仍存在 SSH 子进程' }
        $daemon = Invoke-Ssh ('systemctl is-active whaled; test -S ' + $RemoteData + '/run/whaled.sock && echo SOCKET_OK')
        if ($daemon -notmatch 'SOCKET_OK') { throw '断开控制台后服务器守护进程停止运行' }
        Write-Output 'PASS: 断开连接不停止服务器上的机器人'

        # 同一窗口重新连接（主机密钥已固定且指纹一致，不应再次提示）。
        Invoke-Button $one.Id 'Connection-Connect'
        [void](Wait-Text $one.Id 'ServerState' '已连接服务器' 40)
        Write-Output 'PASS: 断开后可重新连接，固定主机密钥不会重复提示'

        # 两个控制台同时连接同一守护进程。
        $two = Start-Fixture $secondary
        try {
            [void](Wait-Text $two.Id 'ServerState' '已连接服务器' 40)
            [void](Wait-Text $one.Id 'ServerState' '已连接服务器' 10)
            Write-Output 'PASS: 两个控制台可同时连接同一守护进程'
        } finally {
            Stop-Fixture $two
        }
        Start-Sleep -Milliseconds 1200
        [void](Wait-Text $one.Id 'ServerState' '已连接服务器' 10)
        Write-Output 'PASS: 关闭另一控制台不影响当前连接'

        # 网络中断：结束本地 ssh 子进程，应自动重连。
        $sshChildren = Get-ChildSsh $one.Id
        if ($sshChildren.Count -eq 0) { throw '找不到桌面端的 SSH 子进程' }
        foreach ($child in $sshChildren) { Stop-Process -Id $child.ProcessId -Force }
        [void](Wait-Text $one.Id 'ServerState' '中断|已断开|正在连接' 15)
        [void](Wait-Text $one.Id 'ServerState' '已连接服务器' 45)
        Write-Output 'PASS: 连接中断后自动重连恢复'

        # 服务器守护进程重启：控制台应恢复接收状态，机器人按自动启动标记恢复。
        if ($canRestart -and !$SkipServerRestart) {
            Invoke-Ssh 'sudo -n systemctl restart whaled' | Out-Null
            Start-Sleep -Seconds 3
            $deadline = [datetime]::UtcNow.AddSeconds(45)
            do {
                $state = (Find-WithId $one.Id 'ServerState' 500).Current.Name
                $active = Invoke-Ssh 'systemctl is-active whaled'
                if ($active -match 'active' -and $state -match '已连接服务器') { break }
                Start-Sleep -Milliseconds 500
            } until ([datetime]::UtcNow -gt $deadline)
            if ($state -notmatch '已连接服务器') { throw "守护进程重启后控制台未恢复：$state" }
            Write-Output 'PASS: 服务器守护进程重启后控制台恢复连接并接收状态'
        } else {
            Write-Output 'SKIP: 跳过守护进程重启（缺少免密 sudo 或已指定 -SkipServerRestart）'
        }

        # 连接期间取消：对不可达地址发起连接后立即断开，应回到“已断开”且不崩溃。
        $cancel = Start-Fixture $blackhole
        try {
            [void](Find-WithId $cancel.Id 'ServerState' 20000)
            Select-Tab $cancel.Id '连接与运行'
            [void](Wait-Text $cancel.Id 'ServerState' '\S' 15)
            Invoke-Button $cancel.Id 'ServerConnection'
            Start-Sleep -Milliseconds 1200
            $cancelState = Find-WithId $cancel.Id 'ServerState' 500
            if ($cancelState -and $cancelState.Current.Name -notmatch '已断开') { Invoke-Button $cancel.Id 'Connection-Disconnect' }
            [void](Wait-Text $cancel.Id 'ServerState' '已断开' 15)
            if ((Get-ChildSsh $cancel.Id).Count -ne 0) { throw '取消连接后仍存在 SSH 子进程' }
            Write-Output 'PASS: 连接期间取消操作会立即停止转发'
        } finally {
            Stop-Fixture $cancel
        }

        $daemon = Invoke-Ssh ('systemctl is-active whaled; test -S ' + $RemoteData + '/run/whaled.sock && echo SOCKET_OK')
        if ($daemon -notmatch 'SOCKET_OK') { throw '验收结束后服务器守护进程未继续运行' }
        Write-Output 'PASS: 全部远程验收结束后服务器守护进程仍在运行'
    } finally {
        Stop-Fixture $one
    }
} finally {
    Write-Output "远程验收工作区：$testRoot"
}
