param([switch]$ValidateOnly, [string]$PreviewPath, [switch]$TestMode, [ValidateRange(0,4)][int]$PreviewPage = 0, [int]$PreviewWidth = 1100, [int]$PreviewHeight = 740)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$script:projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$xaml = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'window.xaml'), [Text.Encoding]::UTF8)
$reader = [Xml.XmlReader]::Create([IO.StringReader]::new($xaml))
$script:window = [Windows.Markup.XamlReader]::Load($reader)
$reader.Close()
$iconPath = Join-Path $projectRoot 'QQ-BOT.ico'
if ([IO.File]::Exists($iconPath)) { $window.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([uri]$iconPath) }
$script:controls = @{}
foreach ($match in [regex]::Matches($xaml, 'x:Name="([^"]+)"')) {
    $script:controls[$match.Groups[1].Value] = $window.FindName($match.Groups[1].Value)
}
$script:requests = [Collections.Generic.List[object]]::new()
$script:inputs = @{}
$script:settings = $null
$script:settingsDirty = $false
$script:personaDirty = $false
$script:loading = $false
$script:paused = $false
$script:logs = @()
$script:backendUrl = ''
$script:backend = $null
$script:closing = $false
$script:allowClose = $false
$script:exitRequested = $false
$script:tray = $null

function Restore-Console {
    $window.Show()
    $window.WindowState = 'Normal'
    [void]$window.Activate()
    $script:lastPoll = [datetime]::MinValue
}

function Hide-Console {
    $window.Hide()
    if ($tray -and !$TestMode) { $tray.ShowBalloonTip(2500, '小鲸鱼还在这里', '已收进系统托盘，机器人继续运行。右键托盘图标可彻底退出。', [Windows.Forms.ToolTipIcon]::Info) }
}

function Request-Exit {
    $script:exitRequested = $true
    Restore-Console
    $window.Close()
}
$script:lastPoll = [datetime]::MinValue
$script:controlPending = $false
$script:ready = $false
$script:timer = $null
$script:desktopMutex = $null
$script:restoreSignal = $null
$script:ownsMutex = $false
$script:http = [Net.Http.HttpClient]::new()
$http.Timeout = [timespan]::FromSeconds(25)

function Show-Feedback([string]$Text, [bool]$IsError = $false) {
    $controls.Feedback.Text = $Text
    $controls.Feedback.ToolTip = $Text
    $controls.Feedback.Foreground = if ($IsError) { [Windows.Media.Brushes]::Firebrick } else { [Windows.Media.BrushConverter]::new().ConvertFromString('#344454') }
}

function Send-Api([string]$Path, [string]$Method = 'GET', $Body = $null, [scriptblock]$Success = {}, $Button = $null) {
    if (!$backendUrl) { Show-Feedback '本地控制服务尚未就绪，请稍候。' $true; return }
    if (@($requests | Where-Object { $_.Path -eq $Path -and $_.Method -eq $Method }).Count) { return }
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), "$backendUrl/api/$Path")
    if ($null -ne $Body) { $request.Content = [Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 30 -Compress), [Text.Encoding]::UTF8, 'application/json') }
    if ($Button) { $Button.IsEnabled = $false }
    $task = $http.SendAsync($request)
    $requests.Add([pscustomobject]@{ Path = $Path; Method = $Method; Task = $task; Request = $request; Success = $Success; Button = $Button })
}

function Complete-Requests {
    foreach ($item in @($requests.ToArray())) {
        if (!$item.Task.IsCompleted) { continue }
        $response = $null
        try {
            $response = $item.Task.GetAwaiter().GetResult()
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
            if (!$response.IsSuccessStatusCode) { throw $body.error }
            & $item.Success $body
        } catch {
            Show-Feedback $_.Exception.Message $true
            if ($item.Path -eq 'control') { $script:controlPending = $false }
            if ($item.Path -eq 'status') { $controls.ConnectionLabel.Text = '状态获取失败'; $controls.StartButton.IsEnabled = $false; $controls.StopButton.IsEnabled = $false; $controls.RestartButton.IsEnabled = $false }
        } finally {
            if ($item.Button) { $item.Button.IsEnabled = $true }
            if ($response) { $response.Dispose() }
            $item.Request.Dispose()
            [void]$requests.Remove($item)
        }
    }
}

$script:fieldGroups = @(
    @{ Name = '身份与对话'; Fields = @(
        @('identity.name', '机器人名称', 'text', 1, 32),
        @('approval.adminQq', '管理员 QQ', 'number', 0, 9007199254740991),
        @('chat.privateAutoReply', '私聊自动回复', 'bool'),
        @('chat.group.requireMention', '群聊需要 @ 或前缀', 'bool'),
        @('chat.group.prefix', '群聊触发前缀（可留空）', 'text', 0, 32),
        @('chat.group.cooldownMs', '群聊冷却（毫秒）', 'number', 0, 60000),
        @('chat.group.contextLines', '最近群聊摘要行数（0 为关闭）', 'number', 0, 30),
        @('chat.group.followUpMs', '同一群友追问窗口（毫秒，0 为关闭）', 'number', 0, 600000),
        @('chat.delay.chunkSize', '回复分片长度', 'number', 100, 4000),
        @('chat.delay.minMs', '最短回复延迟（毫秒）', 'number', 0, 10000),
        @('chat.delay.maxMs', '最长回复延迟（毫秒）', 'number', 0, 20000)
    )},
    @{ Name = '审批与额度'; Fields = @(
        @('approval.allowExec', '自动允许执行命令（跳过管理员审批）', 'bool'),
        @('approval.timeoutMs', '审批超时（毫秒）', 'number', 5000, 600000),
        @('budgets.proactiveMessagesPerDay', '每日主动消息上限（0 为禁止）', 'number', 0, 100),
        @('budgets.likesPerDay', '每日点赞次数上限', 'number', 0, 200),
        @('chat.group.proactive.enabled', '允许群聊主动发送', 'bool'),
        @('chat.group.proactive.perGroupPerDay', '每群每日主动消息上限', 'number', 0, 20)
    )},
    @{ Name = 'QQ 空间'; Fields = @(
        @('features.qzone.enabled', '允许发布 QQ 空间', 'bool'),
        @('features.qzone.requireConfirm', '发布前需要管理员确认', 'bool'),
        @('features.qzone.dailyLimit', '每日空间发布上限', 'number', 0, 10)
    )}
)
foreach ($group in $fieldGroups) {
    $card = [Windows.Controls.Border]::new(); $card.Style = $window.Resources['Card']
    $panel = [Windows.Controls.StackPanel]::new()
    $heading = [Windows.Controls.TextBlock]::new(); $heading.Style = $window.Resources['Heading']; $heading.Text = $group.Name
    $panel.Children.Add($heading) | Out-Null
    foreach ($field in $group.Fields) {
        $row = [Windows.Controls.Grid]::new(); $row.Margin = '0,0,0,12'
        $left = [Windows.Controls.ColumnDefinition]::new(); $left.Width = [Windows.GridLength]::new(1, [Windows.GridUnitType]::Star)
        $right = [Windows.Controls.ColumnDefinition]::new(); $right.Width = [Windows.GridLength]::new(180)
        $row.ColumnDefinitions.Add($left); $row.ColumnDefinitions.Add($right)
        $label = [Windows.Controls.Label]::new(); $label.Content = $field[1]; $label.VerticalAlignment = 'Center'; $label.FontSize = 12
        if ($field[2] -eq 'bool') {
            $input = [Windows.Controls.CheckBox]::new(); $input.HorizontalAlignment = 'Right'
            $input.Add_Checked({ if (!$script:loading) { $script:settingsDirty = $true } })
            $input.Add_Unchecked({ if (!$script:loading) { $script:settingsDirty = $true } })
        } else {
            $input = [Windows.Controls.TextBox]::new()
            if ($field[2] -eq 'text') { $input.MaxLength = $field[4] }
            $input.Add_TextChanged({ if (!$script:loading) { $script:settingsDirty = $true } })
        }
        [Windows.Automation.AutomationProperties]::SetName($input, $field[1])
        $label.Target = $input
        [Windows.Controls.Grid]::SetColumn($input, 1)
        $row.Children.Add($label) | Out-Null; $row.Children.Add($input) | Out-Null; $panel.Children.Add($row) | Out-Null
        $inputs[$field[0]] = @{ Control = $input; Field = $field }
    }
    $card.Child = $panel; $controls.SettingsFields.Children.Add($card) | Out-Null
}
$note = [Windows.Controls.TextBlock]::new(); $note.Style = $window.Resources['Hint']
$note.Text = '连接地址、令牌与 DSH 路径在 .env 中编辑，需重新打开控制台生效。浏览器工具尚未接入，暂不提供相关开关。'
$controls.SettingsFields.Children.Add($note) | Out-Null

function Get-SettingValue($Object, [string]$Path) {
    $value = $Object
    foreach ($part in $Path.Split('.')) { $value = $value.$part }
    return $value
}
function Set-SettingValue($Object, [string]$Path, $Value) {
    $parts = $Path.Split('.'); $target = $Object
    for ($index = 0; $index -lt $parts.Length - 1; $index++) { $target = $target.($parts[$index]) }
    $target.($parts[-1]) = $Value
}
function Load-Settings($Value) {
    $script:loading = $true
    try {
        $script:settings = $Value
        foreach ($path in $inputs.Keys) {
            $entry = $inputs[$path]; $valueAtPath = Get-SettingValue $Value $path
            if ($entry.Field[2] -eq 'bool') { $entry.Control.IsChecked = [bool]$valueAtPath } else { $entry.Control.Text = [string]$valueAtPath }
        }
        $script:settingsDirty = $false; $controls.SaveSettingsButton.IsEnabled = $true
    } finally { $script:loading = $false }
}
function Save-Settings {
    if (!$settings) { return }
    try {
        $next = $settings | ConvertTo-Json -Depth 30 | ConvertFrom-Json
        foreach ($path in $inputs.Keys) {
            $entry = $inputs[$path]; $field = $entry.Field
            if ($field[2] -eq 'bool') { $value = [bool]$entry.Control.IsChecked }
            elseif ($field[2] -eq 'number') {
                $value = 0L
                if (![long]::TryParse($entry.Control.Text, [ref]$value) -or $value -lt $field[3] -or $value -gt $field[4]) {
                    $entry.Control.Focus() | Out-Null
                    throw "$($field[1]) 必须为 $($field[3]) 到 $($field[4]) 之间的整数。"
                }
            } else {
                $value = $entry.Control.Text
                if ($value.Length -lt $field[3]) { $entry.Control.Focus() | Out-Null; throw "$($field[1]) 不能为空。" }
            }
            Set-SettingValue $next $path $value
        }
        if ($next.chat.delay.minMs -gt $next.chat.delay.maxMs) { $inputs['chat.delay.minMs'].Control.Focus() | Out-Null; throw '最短回复延迟不能大于最长回复延迟。' }
        Send-Api 'settings' 'PUT' $next { param($data) Load-Settings $data; Show-Feedback '配置已保存，运行中的机器人会自动加载。' } $controls.SaveSettingsButton
        $controls.SettingsFields.IsEnabled = $false
    } catch { Show-Feedback $_.Exception.Message $true }
}

function Update-Status($Data) {
    $names = @{ stopped = '已停止'; starting = '启动中'; running = '运行中'; stopping = '停止中'; failed = '启动失败'; unreachable = '状态不可达' }
    $controls.PhaseLabel.Text = $names[[string]$Data.phase]
    $controls.BotName.Text = $Data.settings.identity.name
    $controls.RuntimeDetail.Text = if ($Data.lastError) { $Data.lastError } elseif ($Data.phase -eq 'running') { '已运行 {0} 分钟 · 进程 {1}' -f [math]::Floor($Data.uptimeMs / 60000), $Data.pid } else { '控制台保持在线，随时可以启动机器人。' }
    if ($Data.phase -eq 'running' -and !$Data.wsConnected) {
        $controls.PhaseLabel.Text = '等待 NapCat'
        $controls.RuntimeDetail.Text = '桥接已启动，但 OneBot 尚未连接。请启动 NapCat，并确认其 WebSocket 服务已开启。'
    } elseif ($Data.phase -eq 'running' -and !$Data.qqOnline) {
        $controls.PhaseLabel.Text = '等待 QQ 登录'
        $controls.RuntimeDetail.Text = 'OneBot 已连接，但 QQ 尚未在线。请在 NapCat 中完成 QQ 登录。'
    }
    $controls.MessagesIn.Text = [string]$Data.messagesIn; $controls.MessagesOut.Text = [string]$Data.messagesOut
    $controls.SessionCount.Text = [string]$Data.sessions; $controls.PendingCount.Text = [string]$Data.pendingMessages
    $ws = if ($Data.wsConnected) { '已连接' } else { '未连接' }
    $acp = if ($Data.acpConnected) { '已连接' } else { '未连接' }
    $qq = if ($Data.qqOnline) { '在线' } else { '离线' }
    $controls.Connections.Text = "OneBot  $ws     ·     DSH / ACP  $acp     ·     QQ  $qq"
    $controls.AccountInfo.Text = if ($Data.selfId) { "$($Data.nickname) · $($Data.selfId) · 队列已满丢弃 $($Data.messagesDropped) 条" } else { '等待获取 QQ 登录信息' }
    $controls.ConnectionLabel.Text = '本地服务已连接 · ' + (Get-Date -Format 'HH:mm:ss')
    $controls.StartButton.IsEnabled = !$controlPending -and $Data.phase -in @('stopped', 'failed')
    $controls.StopButton.IsEnabled = !$controlPending -and $Data.phase -in @('running', 'starting', 'unreachable')
    $controls.RestartButton.IsEnabled = !$controlPending -and $Data.phase -notin @('starting', 'stopping')
    $controls.TestButton.IsEnabled = $Data.phase -eq 'running' -and $Data.qqOnline -and @($requests | Where-Object { $_.Path -eq 'test' }).Count -eq 0
    $controls.TestButton.ToolTip = if ($Data.qqOnline) { '向管理员 QQ 发送测试消息' } else { '请先启动 NapCat 并完成 QQ 登录' }
}
function Render-Logs {
    $query = $controls.LogSearch.Text
    $lines = foreach ($entry in $logs) {
        if ($query -and $entry.message.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $time = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$entry.ts).ToLocalTime().ToString('HH:mm:ss')
        '{0}  {1,-5}  {2}' -f $time, $entry.level.ToUpperInvariant(), $entry.message
    }
    $text = $lines -join [Environment]::NewLine
    if ($controls.LogText.Text -ne $text) {
        $atBottom = $controls.LogText.VerticalOffset -ge ($controls.LogText.ExtentHeight - $controls.LogText.ViewportHeight - 20)
        $controls.LogText.Text = $text
        if ($atBottom) { $controls.LogText.ScrollToEnd() }
    }
}
function Refresh-Sessions {
    Send-Api 'sessions' 'GET' $null {
        param($data)
        $controls.SessionList.Children.Clear()
        if (!$data.sessions.Count) {
            $empty = [Windows.Controls.TextBlock]::new(); $empty.Text = '暂无会话。收到首条消息后，会在这里显示。'; $empty.Style = $window.Resources['Hint']
            $controls.SessionList.Children.Add($empty) | Out-Null
        }
        foreach ($session in $data.sessions) {
            $card = [Windows.Controls.Border]::new(); $card.Style = $window.Resources['Card']
            $dock = [Windows.Controls.DockPanel]::new()
            $button = [Windows.Controls.Button]::new(); $button.Content = '重置会话'; $button.Tag = $session.key
            [Windows.Controls.DockPanel]::SetDock($button, 'Right')
            $button.Add_Click({
                param($sender, $eventArgs)
                $answer = [Windows.MessageBox]::Show($window, "重置 $($sender.Tag) 的会话？下次消息将创建新的上下文。", '重置会话', 'YesNo', 'Question')
                if ($answer -eq 'Yes') { Send-Api ('sessions?key=' + [uri]::EscapeDataString($sender.Tag)) 'DELETE' $null { Show-Feedback '会话已重置。'; Refresh-Sessions } $sender }
            })
            $info = [Windows.Controls.StackPanel]::new(); $title = [Windows.Controls.TextBlock]::new(); $title.Text = $session.key; $title.FontWeight = 'SemiBold'
            $detail = [Windows.Controls.TextBlock]::new(); $detail.Text = $session.sessionId; $detail.Style = $window.Resources['Hint']; $detail.TextWrapping = 'Wrap'
            $info.Children.Add($title) | Out-Null; $info.Children.Add($detail) | Out-Null
            $dock.Children.Add($button) | Out-Null; $dock.Children.Add($info) | Out-Null; $card.Child = $dock
            $controls.SessionList.Children.Add($card) | Out-Null
        }
    } $controls.RefreshSessionsButton
}
function Control-Bot([string]$Action) {
    $script:controlPending = $true
    $controls.StartButton.IsEnabled = $false; $controls.StopButton.IsEnabled = $false; $controls.RestartButton.IsEnabled = $false
    Show-Feedback '正在执行操作，请稍候…'
    Send-Api 'control' 'POST' @{ action = $Action } { param($data) $script:controlPending = $false; $script:lastPoll = [datetime]::MinValue; Show-Feedback '操作已完成，正在更新运行状态。' }
}

$pages = @('OverviewPage', 'SettingsPage', 'PersonaPage', 'SessionsPage', 'LogsPage')
$titles = @('运行概览', '机器人配置', '角色与人设', '会话管理', '运行日志')
$descriptions = @('今天也一起，把每一句话好好接住。', '调整对话策略、审批规则与每日额度。', '定义机器人的身份、语气和行为边界。', '查看会话映射，按需重新开始上下文。', '从每一条事件中，了解机器人的运行情况。')
$controls.Navigation.Add_SelectionChanged({
    $index = $controls.Navigation.SelectedIndex
    for ($i = 0; $i -lt $pages.Count; $i++) { $controls[$pages[$i]].Visibility = if ($i -eq $index) { 'Visible' } else { 'Collapsed' } }
    $controls.PageTitle.Text = $titles[$index]; $controls.PageDescription.Text = $descriptions[$index]
    if ($index -eq 3 -and $script:ready) { Refresh-Sessions }
})
$controls.StartButton.Add_Click({ Control-Bot 'start' })
$controls.StopButton.Add_Click({ Control-Bot 'stop' })
$controls.RestartButton.Add_Click({ Control-Bot 'restart' })
$controls.SaveSettingsButton.Add_Click({ Save-Settings })
$controls.PersonaText.Add_TextChanged({ if (!$script:loading) { $script:personaDirty = $true } })
$controls.SavePersonaButton.Add_Click({
    $content = $controls.PersonaText.Text
    $controls.PersonaText.IsReadOnly = $true
    Send-Api 'persona' 'PUT' @{ content = $content } {
        $script:personaDirty = $false; Show-Feedback '人设已保存，重置相关会话后会使用新的上下文。'
    } $controls.SavePersonaButton
})
$controls.RefreshSessionsButton.Add_Click({ Refresh-Sessions })
$controls.TestButton.Add_Click({
    if (!$controls.TestMessage.Text.Trim()) { Show-Feedback '请输入测试消息。' $true; return }
    Send-Api 'test' 'POST' @{ text = $controls.TestMessage.Text } { Show-Feedback '测试消息已发送至管理员 QQ。' } $controls.TestButton
})
$controls.EnvButton.Add_Click({
    $path = Join-Path $projectRoot '.env'
    if (![IO.File]::Exists($path)) { [IO.File]::Copy((Join-Path $projectRoot '.env.example'), $path) }
    Start-Process notepad.exe -ArgumentList ('"' + $path + '"')
    Show-Feedback '编辑 .env 后，请从托盘彻底退出并重新打开控制台，使连接配置生效。'
})
$controls.PauseLogsButton.Add_Click({ $script:paused = !$paused; $controls.PauseLogsButton.Content = if ($paused) { '继续刷新' } else { '暂停刷新' } })
$controls.LogSearch.Add_TextChanged({ Render-Logs })

if ($ValidateOnly -or $PreviewPath) {
    if ($PreviewPath) {
        $controls.Navigation.SelectedIndex = $PreviewPage
        $root = $window.Content
        $root.Background = $window.Background
        $root.Measure([Windows.Size]::new($PreviewWidth, $PreviewHeight)); $root.Arrange([Windows.Rect]::new(0, 0, $PreviewWidth, $PreviewHeight)); $root.UpdateLayout()
        $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new($PreviewWidth, $PreviewHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
        $bitmap.Render($root); $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new(); $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
        $stream = [IO.File]::Create($PreviewPath); try { $encoder.Save($stream) } finally { $stream.Dispose() }
    }
    Write-Output "WPF 验证通过：$($controls.Count) 个控件，$($inputs.Count) 个配置字段。"
    $http.Dispose(); $window.Close(); exit 0
}

try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $lockKey = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '') } finally { $hasher.Dispose() }
    $mutexSuffix = if ($TestMode) { '-test-' + $PID } else { '' }
    $script:restoreSignal = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, ('Local\QQBotDesktopRestore-' + $lockKey + $mutexSuffix))
    $script:desktopMutex = [Threading.Mutex]::new($true, ('Local\QQBotDesktop-' + $lockKey + $mutexSuffix), [ref]$script:ownsMutex)
    if (!$ownsMutex) { [void]$restoreSignal.Set(); return }
    $node = Join-Path $projectRoot 'runtime/node.exe'
    if (![IO.File]::Exists($node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
    if (![IO.File]::Exists((Join-Path $projectRoot 'dist/console.js'))) { throw '缺少构建产物，请先运行 npm run build，或使用 npm run ui 启动。' }
    $tokenBytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($tokenBytes); $rng.Dispose()
    $token = [Convert]::ToBase64String($tokenBytes)
    $http.DefaultRequestHeaders.Add('x-admin-token', $token)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node; $info.Arguments = '--env-file-if-exists=.env dist/console.js'; $info.WorkingDirectory = $projectRoot
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8; $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.EnvironmentVariables['ADMIN_UI_PORT'] = '0'; $info.EnvironmentVariables['ADMIN_UI_TOKEN'] = $token; $info.EnvironmentVariables['BOT_DESKTOP'] = '1'
    $script:backend = [Diagnostics.Process]::new(); $backend.StartInfo = $info
    [void]$backend.Start()
    $script:stdoutTask = $backend.StandardOutput.ReadLineAsync(); $script:stderrTask = $backend.StandardError.ReadLineAsync()
    $script:startupAt = Get-Date
    $script:timer = [Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [timespan]::FromMilliseconds(250)
    $timer.Add_Tick({
        try {
            if ($restoreSignal.WaitOne(0) -and !$closing) { Restore-Console }
            if ($backend.HasExited -and $closing) { $script:allowClose = $true; $window.Close(); return }
            if ($closing) {
                if (((Get-Date) - $script:closeAt).TotalSeconds -gt 18) {
                    $killer = [Diagnostics.ProcessStartInfo]::new('taskkill.exe', "/PID $($backend.Id) /T /F"); $killer.UseShellExecute = $false; $killer.CreateNoWindow = $true
                    [Diagnostics.Process]::Start($killer).Dispose(); $script:closeAt = Get-Date
                }
                return
            }
            foreach ($kind in @('stdout', 'stderr')) {
                $task = Get-Variable -Name ($kind + 'Task') -ValueOnly -Scope Script
                $count = 0
                while ($task -and $task.IsCompleted -and $count -lt 30) {
                    $line = $task.GetAwaiter().GetResult()
                    if ($null -eq $line) { Set-Variable -Name ($kind + 'Task') -Value $null -Scope Script; break }
                    if ($line -match '^\[admin\] (http://127\.0\.0\.1:\d+)$') {
                        $script:backendUrl = $Matches[1]; $script:ready = $true
                        Send-Api 'settings' 'GET' $null { param($data) Load-Settings $data }
                        Send-Api 'persona' 'GET' $null { param($data) $script:loading = $true; $controls.PersonaText.Text = $data.content; $script:loading = $false; $script:personaDirty = $false; $controls.SavePersonaButton.IsEnabled = $true }
                        Show-Feedback '桌面控制台已就绪。点击“启动机器人”开始运行。'
                    } elseif ($kind -eq 'stderr') { Show-Feedback $line $true }
                    $task = if ($kind -eq 'stdout') { $backend.StandardOutput.ReadLineAsync() } else { $backend.StandardError.ReadLineAsync() }
                    Set-Variable -Name ($kind + 'Task') -Value $task -Scope Script; $count++
                }
            }
            if ($backend.HasExited) {
                $controls.ConnectionLabel.Text = '本地服务已退出'
                Show-Feedback ("本地服务已退出，请检查配置后重新打开。 " + $controls.Feedback.Text) $true
                $controls.StartButton.IsEnabled = $false; $controls.StopButton.IsEnabled = $false; $controls.RestartButton.IsEnabled = $false
                $timer.Stop(); return
            }
            Complete-Requests
            $controls.SettingsFields.IsEnabled = @($requests | Where-Object { $_.Path -eq 'settings' -and $_.Method -eq 'PUT' }).Count -eq 0
            if ($ready -and ((Get-Date) - $lastPoll).TotalSeconds -ge 3 -and $window.IsVisible -and $window.WindowState -ne 'Minimized') {
                $script:lastPoll = Get-Date
                Send-Api 'status' 'GET' $null { param($data) Update-Status $data }
                if (!$paused -and $controls.Navigation.SelectedIndex -eq 4) { Send-Api 'logs' 'GET' $null { param($data) $script:logs = @($data.logs); Render-Logs } }
            }
            $controls.PersonaText.IsReadOnly = @($requests | Where-Object { $_.Path -eq 'persona' -and $_.Method -eq 'PUT' }).Count -gt 0
            if (!$ready -and ((Get-Date) - $startupAt).TotalSeconds -gt 15) { Show-Feedback '控制服务启动时间较长，请检查本地配置；也可以关闭后重新打开。' $true }
        } catch { Show-Feedback $_.Exception.Message $true }
    })
    $window.Add_Closing({
        param($sender, $eventArgs)
        if (!$exitRequested -and !$allowClose) {
            $eventArgs.Cancel = $true
            Hide-Console
            return
        }
        if ($allowClose -or !$backend -or $backend.HasExited) { return }
        $eventArgs.Cancel = $true
        if ($closing) { return }
        if ($settingsDirty -or $personaDirty) {
            $answer = [Windows.MessageBox]::Show($window, '有尚未保存的修改。关闭会丢弃这些修改，并停止机器人。是否继续？', '关闭控制台', 'YesNo', 'Warning')
            if ($answer -ne 'Yes') { $script:exitRequested = $false; return }
        }
        $script:closing = $true; $script:closeAt = Get-Date
        Show-Feedback '正在停止机器人并清理进程，请稍候…'
        $controls.Navigation.IsEnabled = $false
        $backend.StandardInput.WriteLine('shutdown'); $backend.StandardInput.Close()
    })
    $script:tray = [Windows.Forms.NotifyIcon]::new()
    $tray.Text = '小鲸鱼 · QQ-BOT 控制台'
    $tray.Icon = if ([IO.File]::Exists($iconPath)) { [Drawing.Icon]::new($iconPath) } else { [Drawing.SystemIcons]::Application.Clone() }
    $menu = [Windows.Forms.ContextMenuStrip]::new()
    $openItem = $menu.Items.Add('打开控制台')
    $openItem.Add_Click({ Restore-Console })
    [void]$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new())
    $exitItem = $menu.Items.Add('退出并停止机器人')
    $exitItem.Add_Click({ Request-Exit })
    $tray.ContextMenuStrip = $menu
    $tray.Add_MouseClick({
        param($sender, $eventArgs)
        if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left) { Restore-Console }
    })
    $tray.Add_DoubleClick({ Restore-Console })
    $tray.Visible = !$TestMode
    $timer.Start()
    if ($TestMode) {
        $window.WindowStartupLocation = 'Manual'; $window.Left = -32000; $window.Top = -32000; $window.ShowInTaskbar = $false
    }
    $script:application = [Windows.Application]::new()
    $application.ShutdownMode = 'OnExplicitShutdown'
    $window.Add_Closed({ $script:application.Shutdown() })
    [void]$application.Run($window)
} catch {
    [Windows.MessageBox]::Show($_.Exception.Message, 'QQ BOT 启动失败', 'OK', 'Error') | Out-Null
} finally {
    if ($tray) { $tray.Visible = $false; $tray.Icon.Dispose(); $tray.Dispose(); $menu.Dispose() }
    if ($timer) { $timer.Stop() }
    if ($backend -and !$backend.HasExited) {
        try { $backend.StandardInput.Close(); if (!$backend.WaitForExit(12000)) { $killer = [Diagnostics.ProcessStartInfo]::new('taskkill.exe', "/PID $($backend.Id) /T /F"); $killer.UseShellExecute = $false; $killer.CreateNoWindow = $true; [Diagnostics.Process]::Start($killer).Dispose() } } catch { }
    }
    foreach ($item in $requests) { $item.Request.Dispose() }
    $http.Dispose()
    if ($backend) { $backend.Dispose() }
    if ($desktopMutex) { if ($ownsMutex) { $desktopMutex.ReleaseMutex() }; $desktopMutex.Dispose() }
    if ($restoreSignal) { $restoreSignal.Dispose() }
}
