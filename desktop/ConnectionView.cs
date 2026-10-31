using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

partial class App
{
    public class RemoteProfile {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Host { get; set; }
        public int Port { get; set; }
        public string User { get; set; }
        public string KeyFile { get; set; }
        public string Node { get; set; }
        public string Program { get; set; }
        public string DataDir { get; set; }
        public string Fingerprint { get; set; }
    }
    public class RemoteConfig {
        public int Version { get; set; }
        public string Mode { get; set; }
        public string Active { get; set; }
        public List<RemoteProfile> Profiles { get; set; }
    }
    class HostKeyScan { public List<string> Lines; public string Fingerprint; public string Error; }

    static RemoteConfig remoteConfig = new RemoteConfig { Version = 1, Mode = "local", Active = "", Profiles = new List<RemoteProfile>() };
    static string remoteDir, remoteConfigPath, knownHostsPath;
    static string connectionMode = "local", remoteStatus = "", remoteLastError = "";
    static bool remoteDesired, remoteEverConnected, remoteConnecting;
    static int remoteReconnectAttempt;
    static DateTime remoteReconnectAt = DateTime.MinValue;
    static Window connectionDialog;
    static ComboBox connectionModeBox, connectionProfileBox;
    static TextBox connectionName, connectionHost, connectionPort, connectionUser, connectionKey, connectionNode, connectionProgram, connectionData;
    static TextBlock connectionStatusText, connectionKeyStatus, connectionErrorText;
    static Button connectionConnectButton, connectionSaveButton, connectionDisconnectButton, connectionDeleteButton, connectionNewButton, connectionBrowseKey;
    static bool loadingConnectionForm, hostKeyBusy;

    static void InitConnectionView() {
        remoteDir = Path.Combine(dataRoot, "remote");
        remoteConfigPath = Path.Combine(remoteDir, "connections.json");
        knownHostsPath = Path.Combine(remoteDir, "known_hosts");
        LoadConnectionConfig();
        connectionMode = remoteConfig.Mode == "remote" ? "remote" : "local";
        Find<Button>("ServerConnection").Click += (s, e) => OpenServerConnection();
        ApplyConnectionModeUI();
    }

    static void LoadConnectionConfig() {
        try {
            if (File.Exists(remoteConfigPath)) {
                var loaded = json.Deserialize<RemoteConfig>(File.ReadAllText(remoteConfigPath, Encoding.UTF8));
                if (loaded != null && loaded.Version == 1 && loaded.Profiles != null) remoteConfig = loaded;
            }
        } catch (Exception error) {
            Feedback("服务器连接配置无法读取，已使用默认设置：" + error.Message);
        }
        if (remoteConfig.Profiles == null) remoteConfig.Profiles = new List<RemoteProfile>();
        remoteConfig.Profiles = remoteConfig.Profiles.Where(profile => profile != null).ToList();
        if (remoteConfig.Mode != "remote") remoteConfig.Mode = "local";
        if (!remoteConfig.Profiles.Any(profile => profile.Id == remoteConfig.Active)) remoteConfig.Active = remoteConfig.Profiles.Count > 0 ? remoteConfig.Profiles[0].Id : "";
    }

    static void SaveConnectionConfig() {
        try {
            Directory.CreateDirectory(remoteDir);
            string temp = remoteConfigPath + ".tmp";
            File.WriteAllText(temp, json.Serialize(remoteConfig), new UTF8Encoding(false));
            if (File.Exists(remoteConfigPath)) File.Replace(temp, remoteConfigPath, null);
            else File.Move(temp, remoteConfigPath);
        } catch (Exception error) {
            Feedback("无法保存服务器连接配置：" + error.Message);
        }
    }

    static RemoteProfile ActiveRemoteProfile() {
        return remoteConfig.Profiles.FirstOrDefault(profile => profile.Id == remoteConfig.Active) ?? remoteConfig.Profiles.FirstOrDefault();
    }

    static bool SafeRemotePath(string value) {
        return !string.IsNullOrEmpty(value) && value.Length > 1 && value[0] == '/' && Regex.IsMatch(value, @"^/[A-Za-z0-9_@./:+-]*$") && value.Split('/').All(segment => segment != "..");
    }

    static bool SafeRemoteCommand(string value) {
        return !string.IsNullOrEmpty(value) && !value.StartsWith("-") && Regex.IsMatch(value, @"^[A-Za-z0-9_@./:+-]+$");
    }

    static string ValidateProfile(RemoteProfile profile, bool requireKey) {
        if (profile == null) return "请先选择或新建一个服务器连接配置。";
        if (string.IsNullOrWhiteSpace(profile.Name) || profile.Name.Length > 40) return "请填写 1–40 个字符的连接名称。";
        if (string.IsNullOrEmpty(profile.Host) || !Regex.IsMatch(profile.Host, @"^[A-Za-z0-9._:-]+$") || profile.Host.StartsWith("-")) return "服务器地址只能包含字母、数字、点、冒号、下划线和短横线。";
        if (profile.Port < 1 || profile.Port > 65535) return "SSH 端口应在 1–65535 之间。";
        if (string.IsNullOrEmpty(profile.User) || !Regex.IsMatch(profile.User, @"^[A-Za-z0-9._-]+$")) return "登录用户只能包含字母、数字、点、下划线和短横线。";
        if (!string.IsNullOrEmpty(profile.KeyFile) && !File.Exists(profile.KeyFile)) return "找不到私钥文件：" + profile.KeyFile;
        if (requireKey && string.IsNullOrEmpty(profile.KeyFile)) return "请选择 SSH 私钥文件。";
        if (!SafeRemoteCommand(string.IsNullOrWhiteSpace(profile.Node) ? "node" : profile.Node)) return "服务器上的 Node 命令或路径包含不支持的字符。";
        if (!SafeRemotePath(profile.Program)) return "服务器程序目录必须是以 / 开头的绝对路径，且不能包含 .. 或特殊字符。";
        if (!SafeRemotePath(profile.DataDir)) return "服务器数据目录必须是以 / 开头的绝对路径，且不能包含 .. 或特殊字符。";
        return null;
    }

    static string SshTool(string name) {
        string windows = Environment.GetEnvironmentVariable("WINDIR") ?? @"C:\Windows";
        string built = Path.Combine(windows, "System32", "OpenSSH", name + ".exe");
        return File.Exists(built) ? built : name;
    }

    static string KnownHostToken(RemoteProfile profile) {
        return profile.Port == 22 ? profile.Host : "[" + profile.Host + "]:" + profile.Port.ToString(CultureInfo.InvariantCulture);
    }

    static bool HostKeyPinned(RemoteProfile profile) {
        if (profile == null || !File.Exists(knownHostsPath)) return false;
        string token = KnownHostToken(profile);
        try {
            return File.ReadAllLines(knownHostsPath).Any(line => line.Trim().Length > 0 && (line.Split(' ')[0] == token || (profile.Port == 22 && line.Split(' ')[0] == profile.Host)));
        } catch { return false; }
    }

    static string NormalizeKeyLine(string line, RemoteProfile profile) {
        var parts = line.Split(new[] { ' ', '\t' }, 3, StringSplitOptions.RemoveEmptyEntries);
        return parts.Length < 3 ? null : KnownHostToken(profile) + " " + parts[1] + " " + parts[2];
    }

    static string FingerprintSummary(string output) {
        if (string.IsNullOrEmpty(output)) return "";
        return string.Join("\n", output.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0).Select(line => {
            var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            return parts.Length >= 2 ? parts[0] + " " + parts[1] + (parts.Length > 3 ? " " + parts[parts.Length - 1] : "") : line;
        }).OrderBy(line => line, StringComparer.Ordinal));
    }

    static string KnownHostFingerprint(RemoteProfile profile) {
        if (profile == null || !File.Exists(knownHostsPath)) return "";
        string ignored;
        string output = RunCapture(SshTool("ssh-keygen"), "-lf " + QuoteArgument(knownHostsPath), 10000, out ignored);
        if (output == null) return "";
        string token = KnownHostToken(profile);
        var relevant = output.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0).Where(line => {
            var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 3) return false;
            string comment = parts[2];
            return comment == token || (profile.Port == 22 && comment == profile.Host);
        });
        return FingerprintSummary(string.Join("\n", relevant));
    }

    static string RunCapture(string file, string arguments, int timeoutMs, out string stderr) {
        stderr = "";
        try {
            var info = new ProcessStartInfo(file, arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            using (var process = Process.Start(info)) {
                process.StandardInput.Close();
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeoutMs)) {
                    try { process.Kill(); } catch { }
                    stderr = "操作超时";
                    return null;
                }
                stderr = errors.Result;
                return process.ExitCode == 0 ? output.Result : null;
            }
        } catch (Exception error) {
            stderr = error.Message;
            return null;
        }
    }

    static string ShortError(string text) {
        if (string.IsNullOrEmpty(text)) return "";
        var line = text.Split('\n').Select(item => item.Trim()).LastOrDefault(item => item.Length > 0 && !item.StartsWith("Warning:", StringComparison.OrdinalIgnoreCase));
        if (string.IsNullOrEmpty(line)) line = text.Trim();
        return line.Length > 300 ? line.Substring(0, 300) + "…" : line;
    }

    /** 用 ssh 本身抓取主机密钥：Windows OpenSSH 的 ssh-keyscan 无法协商部分新版服务器的 KEX。 */
    static HostKeyScan ScanHostKeys(RemoteProfile profile) {
        var result = new HostKeyScan { Lines = new List<string>() };
        Directory.CreateDirectory(remoteDir);
        string temp = Path.Combine(remoteDir, "scan-" + Guid.NewGuid().ToString("N"));
        try {
            var args = new List<string> { "-T" };
            if (!string.IsNullOrEmpty(profile.KeyFile)) { args.Add("-o"); args.Add("IdentitiesOnly=yes"); args.Add("-i"); args.Add(QuoteArgument(profile.KeyFile)); }
            args.Add("-o"); args.Add("BatchMode=yes");
            args.Add("-o"); args.Add("ConnectTimeout=8");
            args.Add("-o"); args.Add("StrictHostKeyChecking=accept-new");
            args.Add("-o"); args.Add("GlobalKnownHostsFile=NUL");
            args.Add("-o"); args.Add("UpdateHostKeys=no");
            args.Add("-o"); args.Add("UserKnownHostsFile=" + QuoteArgument(temp));
            args.Add("-p"); args.Add(profile.Port.ToString(CultureInfo.InvariantCulture));
            args.Add(profile.User + "@" + profile.Host);
            args.Add("true");
            string errors;
            RunCapture(SshTool("ssh"), string.Join(" ", args), 15000, out errors);
            if (!File.Exists(temp)) {
                result.Error = "无法读取服务器主机密钥：" + (ShortError(errors).Length > 0 ? ShortError(errors) : "请检查地址、端口与网络。");
                return result;
            }
            var raw = File.ReadAllLines(temp).Select(line => line.Trim()).Where(line => line.Length > 0 && !line.StartsWith("#")).ToList();
            foreach (var line in raw) { var normalized = NormalizeKeyLine(line, profile); if (normalized != null) result.Lines.Add(normalized); }
            if (result.Lines.Count == 0) { result.Error = "服务器返回的主机密钥格式无法识别。"; return result; }
            string keygenError;
            string output = RunCapture(SshTool("ssh-keygen"), "-lf " + QuoteArgument(temp), 10000, out keygenError);
            if (output == null) { result.Error = "无法计算服务器主机密钥指纹：" + ShortError(keygenError); return result; }
            result.Fingerprint = FingerprintSummary(output);
            return result;
        } finally {
            try { File.Delete(temp); } catch { }
        }
    }

    static bool ConfirmHostKey(RemoteProfile profile, HostKeyScan scan) {
        Window owner = connectionDialog ?? window;
        bool pinned = HostKeyPinned(profile);
        if (!pinned) {
            return MessageBox.Show(owner, "首次连接服务器 " + profile.Host + "（端口 " + profile.Port + "）。\n\n服务器返回的主机密钥指纹：\n" + scan.Fingerprint + "\n\n请通过其他可信方式核对。只有确认无误后才保存并连接。", "确认服务器主机密钥", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) == MessageBoxResult.Yes;
        }
        string known = KnownHostFingerprint(profile);
        if (string.IsNullOrEmpty(known)) {
            return MessageBox.Show(owner, "已存在主机密钥记录，但无法读取旧指纹。\n\n本次指纹：\n" + scan.Fingerprint + "\n\n是否更新并继续？", "确认服务器主机密钥", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) == MessageBoxResult.Yes;
        }
        if (known == scan.Fingerprint) return true;
        return MessageBox.Show(owner, "服务器主机密钥与已保存记录不一致！\n\n已保存：\n" + known + "\n\n本次：\n" + scan.Fingerprint + "\n\n这可能表示服务器重装、密钥更换，或网络被劫持。仅在确认服务器确实更换密钥后更新。", "主机密钥已变化", MessageBoxButton.YesNo, MessageBoxImage.Stop, MessageBoxResult.No) == MessageBoxResult.Yes;
    }

    static void SaveHostKey(RemoteProfile profile, List<string> lines, string fingerprint) {
        Directory.CreateDirectory(remoteDir);
        string token = KnownHostToken(profile);
        var kept = new List<string>();
        if (File.Exists(knownHostsPath)) {
            foreach (var line in File.ReadAllLines(knownHostsPath)) {
                string first = line.Split(' ')[0];
                if (first == token || (profile.Port == 22 && first == profile.Host)) continue;
                if (line.Trim().Length > 0) kept.Add(line);
            }
        }
        kept.AddRange(lines);
        File.WriteAllLines(knownHostsPath, kept, new UTF8Encoding(false));
        profile.Fingerprint = fingerprint;
        SaveConnectionConfig();
    }

    static string RemoteProgramCommand(RemoteProfile profile) {
        string node = string.IsNullOrWhiteSpace(profile.Node) ? "node" : profile.Node.Trim();
        return "exec " + node + " " + profile.Program.TrimEnd('/') + "/scripts/remote-host.mjs --data-dir " + profile.DataDir.TrimEnd('/');
    }

    static string RemoteSshArguments(RemoteProfile profile) {
        var args = new List<string> { "-T" };
        if (!string.IsNullOrEmpty(profile.KeyFile)) { args.Add("-i"); args.Add(QuoteArgument(profile.KeyFile)); args.Add("-o"); args.Add("IdentitiesOnly=yes"); }
        args.Add("-o"); args.Add("BatchMode=yes");
        args.Add("-o"); args.Add("StrictHostKeyChecking=yes");
        args.Add("-o"); args.Add("GlobalKnownHostsFile=NUL");
        args.Add("-o"); args.Add("UpdateHostKeys=no");
        args.Add("-o"); args.Add("UserKnownHostsFile=" + QuoteArgument(knownHostsPath));
        args.Add("-o"); args.Add("ConnectTimeout=10");
        args.Add("-o"); args.Add("ServerAliveInterval=15");
        args.Add("-o"); args.Add("ServerAliveCountMax=3");
        args.Add("-o"); args.Add("LogLevel=ERROR");
        args.Add("-p"); args.Add(profile.Port.ToString(CultureInfo.InvariantCulture));
        args.Add(profile.User + "@" + profile.Host);
        args.Add(QuoteArgument(RemoteProgramCommand(profile)));
        return string.Join(" ", args);
    }

    static void StartHost() {
        if (connectionMode == "remote") {
            var profile = ActiveRemoteProfile();
            string error = ValidateProfile(profile, false);
            if (error != null) {
                remoteStatus = "配置需要处理";
                SetRemoteBadge("服务器未连接", error);
                Feedback("服务器连接配置需要处理：" + error);
                return;
            }
            if (!HostKeyPinned(profile)) {
                remoteStatus = "尚未确认主机密钥";
                SetRemoteBadge("服务器未连接", "请打开「服务器连接」确认服务器主机密钥。");
                Feedback("尚未确认服务器主机密钥，请打开「服务器连接」继续。");
                return;
            }
            StartRemoteHost(profile, false);
        } else StartLocalHost();
    }

    static void StartLocalHost() {
        StopHostQuietly();
        remoteStatus = "";
        var info = new ProcessStartInfo(nodeExecutable, QuoteArgument(Path.Combine(root, "desktop/host.mjs")) + " " + startupArguments) { WorkingDirectory = launchDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        info.EnvironmentVariables["QQBOT_LOW_INTEGRITY"] = NativeTray.IsLowIntegrity() ? "1" : "0";
        StartHostProcess(info, false);
        UpdateConnectionStatus();
    }

    static void StartRemoteHost(RemoteProfile profile, bool reconnect) {
        StopHostQuietly();
        remoteLastError = "";
        remoteStatus = reconnect ? "正在重新连接服务器…" : "正在连接服务器…";
        var info = new ProcessStartInfo(SshTool("ssh"), RemoteSshArguments(profile)) { WorkingDirectory = launchDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        StartHostProcess(info, true);
        remoteConnecting = true;
        UpdateConnectionStatus();
        // 连接建立后 remote-host 会缓冲这两条请求，重连时也重新同步服务器状态与诊断。
        Send("load");
        Send("diagnose");
    }

    static void StartHostProcess(ProcessStartInfo info, bool remote) {
        hostFailed = false;
        host = new Process { StartInfo = info, EnableRaisingEvents = true };
        host.OutputDataReceived += (s, e) => { if (e.Data != null) events.Enqueue(e.Data); };
        host.ErrorDataReceived += (s, e) => {
            if (e.Data == null) return;
            if (remote) {
                remoteLastError = e.Data;
                events.Enqueue(json.Serialize(new { type = "log", text = "[ssh] " + e.Data }));
            } else if (IsSqliteNotice(e.Data)) events.Enqueue("{\"type\":\"log\",\"text\":\"[runtime] 当前 Node 版本将 SQLite 标记为实验功能；此提示不影响数据库运行。\"}");
            else if (!e.Data.StartsWith("(Use `node --trace-warnings")) events.Enqueue("{\"type\":\"error\",\"text\":\"控制进程异常，请检查配置与 Node 版本。\"}");
        };
        host.Start();
        hostInput = new StreamWriter(host.StandardInput.BaseStream, new UTF8Encoding(false));
        host.BeginOutputReadLine();
        host.BeginErrorReadLine();
    }

    static void StopHostQuietly() {
        try { if (hostInput != null) hostInput.Close(); } catch { }
        try { if (host != null && !host.HasExited) host.Kill(); } catch { }
        host = null;
        hostInput = null;
    }

    static void SwitchToLocal() {
        remoteDesired = false;
        remoteEverConnected = false;
        remoteReconnectAt = DateTime.MinValue;
        remoteStatus = "";
        connectionMode = "local";
        remoteConfig.Mode = "local";
        SaveConnectionConfig();
        StopHostQuietly();
        ApplyConnectionModeUI();
        StartLocalHost();
        Send("load");
        Send("diagnose");
        Feedback("已切换到本地运行。");
    }

    static void ConnectToRemote(RemoteProfile profile) {
        remoteConfig.Mode = "remote";
        remoteConfig.Active = profile.Id;
        connectionMode = "remote";
        remoteDesired = true;
        remoteEverConnected = false;
        remoteReconnectAttempt = 0;
        remoteReconnectAt = DateTime.MinValue;
        remoteStatus = "正在连接服务器…";
        SaveConnectionConfig();
        ApplyConnectionModeUI();
        StartRemoteHost(profile, false);
        Feedback("正在连接服务器…");
    }

    static void DisconnectRemote() {
        if (connectionMode != "remote") return;
        remoteDesired = false;
        remoteEverConnected = false;
        remoteReconnectAt = DateTime.MinValue;
        remoteStatus = "已断开";
        StopHostQuietly();
        SetRemoteBadge("服务器未连接", "已断开服务器连接；机器人仍在服务器上运行。");
        Feedback("已断开服务器连接；机器人仍在服务器上运行。");
        UpdateConnectionStatus();
    }

    static void NoteRemoteEvent() {
        if (connectionMode != "remote") return;
        bool changed = !remoteEverConnected || remoteStatus != "已连接服务器";
        remoteEverConnected = true;
        remoteConnecting = false;
        remoteReconnectAttempt = 0;
        remoteReconnectAt = DateTime.MinValue;
        if (hostFailed) hostFailed = false;
        if (changed) { remoteStatus = "已连接服务器"; Feedback("已连接到服务器。"); UpdateConnectionStatus(); }
    }

    static void ScheduleRemoteReconnect() {
        remoteReconnectAttempt++;
        int delay = Math.Min(30, 2 * (1 << Math.Min(remoteReconnectAttempt - 1, 4)));
        remoteReconnectAt = DateTime.UtcNow.AddSeconds(delay);
        remoteStatus = "连接中断，将在 " + delay + " 秒后重连";
        SetRemoteBadge("服务器连接中断", "与服务器的连接已断开，正在等待自动重连。");
        Feedback("与服务器的连接已断开，" + delay + " 秒后自动重连；可打开「服务器连接」取消。");
        UpdateConnectionStatus();
    }

    static void ReportRemoteExit() {
        string text = remoteLastError ?? "";
        if (text.IndexOf("Host key verification failed", StringComparison.OrdinalIgnoreCase) >= 0) Feedback("服务器主机密钥校验失败。请打开「服务器连接」，核对并更新主机密钥后再连接。");
        else if (text.IndexOf("UNPROTECTED PRIVATE KEY FILE", StringComparison.OrdinalIgnoreCase) >= 0 || text.IndexOf("bad permissions", StringComparison.OrdinalIgnoreCase) >= 0) Feedback("SSH 拒绝使用权限过宽的私钥。请收紧私钥文件权限（仅当前用户可读）后重试。");
        else if (text.IndexOf("Permission denied", StringComparison.OrdinalIgnoreCase) >= 0) Feedback("服务器拒绝了 SSH 密钥认证。请检查用户名和私钥是否匹配，并确认公钥已加入服务器账户的 authorized_keys。");
        else if (text.IndexOf("Connection refused", StringComparison.OrdinalIgnoreCase) >= 0 || text.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0 || text.IndexOf("No route", StringComparison.OrdinalIgnoreCase) >= 0) Feedback("无法连接服务器：请检查地址、端口和网络。");
        else if (text.Length > 0) Feedback("服务器连接已断开：" + ShortError(text));
        else Feedback("与服务器的连接已断开；请确认服务器守护进程正在运行后重新连接。");
    }

    static void HandleHostExit(DispatcherTimer timer) {
        if (exiting) { timer.Stop(); window.Close(); return; }
        if (connectionMode == "remote") {
            if (!hostFailed) {
                hostFailed = true;
                remoteConnecting = false;
                if (remoteDesired && remoteEverConnected) ScheduleRemoteReconnect();
                else {
                    remoteStatus = "连接已断开";
                    SetRemoteBadge("服务器未连接", "与服务器的连接已断开；机器人不受本控制台影响。");
                    ReportRemoteExit();
                }
            }
            if (remoteReconnectAt != DateTime.MinValue && DateTime.UtcNow >= remoteReconnectAt) {
                remoteReconnectAt = DateTime.MinValue;
                var profile = ActiveRemoteProfile();
                if (profile != null) StartRemoteHost(profile, true);
            }
            return;
        }
        if (!hostFailed) {
            hostFailed = true;
            Find<TextBlock>("State").Text = "控制进程已退出";
            Feedback("请退出并重新打开控制台。");
        }
    }

    static void SetRemoteBadge(string badge, string state) {
        var label = Find<TextBlock>("ConnectionBadge");
        if (label != null) { label.Text = badge; label.Foreground = Color("#97733F"); }
        var dot = Find<System.Windows.Shapes.Ellipse>("ConnectionDot");
        if (dot != null) dot.Fill = Color("#97733F");
        var pill = Find<Border>("ConnectionPill");
        if (pill != null) pill.Background = Color("#FCF5E9");
        var text = Find<TextBlock>("State");
        if (text != null) text.Text = state;
        UpdateConnectionStatus();
    }

    static void ApplyConnectionModeUI() {
        bool remote = connectionMode == "remote";
        var state = Find<TextBlock>("ServerState");
        if (state != null) {
            state.Text = remote ? (remoteStatus.Length > 0 ? remoteStatus : "服务器模式") : "本地运行";
            state.Foreground = remote ? (remoteEverConnected && host != null && !host.HasExited ? (Brush)Application.Current.Resources["Success"] : Ink("Muted")) : Ink("Muted");
        }
        var button = Find<Button>("ServerConnection");
        if (button != null) button.ToolTip = remote ? "查看或更改服务器连接" : "连接远程服务器";
        var logs = Find<Button>("OpenLogs");
        if (logs != null) { logs.Visibility = Visibility.Visible; logs.Content = remote ? "下载服务器日志" : "打开日志目录"; }
        var memory = Find<Button>("Memory");
        if (memory != null && remote) memory.Visibility = Visibility.Collapsed;
        var maintenance = Find<Button>("OpenDataMaintenance");
        if (maintenance != null) { maintenance.IsEnabled = true; maintenance.ToolTip = remote ? "在服务器上生成备份与诊断，并下载到本机" : "备份与恢复本机数据"; }
        foreach (var browse in runtimeBrowses.Values) if (browse != null) browse.Visibility = remote ? Visibility.Collapsed : Visibility.Visible;
        RefreshMaintenanceMode();
        if (connectionDialog != null) RefreshConnectionDialog();
    }

    static void UpdateConnectionStatus() {
        var state = Find<TextBlock>("ServerState");
        if (state != null && connectionMode == "remote") {
            state.Text = remoteStatus.Length > 0 ? remoteStatus : "服务器模式";
            state.Foreground = remoteEverConnected && host != null && !host.HasExited ? (Brush)Application.Current.Resources["Success"] : Ink("Muted");
        }
        if (connectionDialog != null) RefreshConnectionDialog();
    }

    static void OpenServerConnection(bool preview = false) {
        if (connectionDialog != null) { connectionDialog.Activate(); return; }
        connectionDialog = new Window { Title = "服务器连接", Owner = preview ? null : window, Width = 700, Height = Math.Min(760, SystemParameters.WorkArea.Height - 30), MinWidth = 600, MinHeight = 600, WindowStartupLocation = WindowStartupLocation.CenterOwner, Resources = window.Resources, Background = window.Background, Foreground = window.Foreground, FontFamily = window.FontFamily, FontSize = 13 };
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(new TextBlock { Text = "机器人在哪里运行", FontSize = 21, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 10) });
        panel.Children.Add(new TextBlock { Text = "本地模式保持原有用法；远程模式让机器人运行在服务器上，本机控制台通过 SSH 管理。关闭控制台或断开连接不会停止服务器上的机器人。", TextWrapping = TextWrapping.Wrap, Foreground = Ink("Muted"), LineHeight = 21, Margin = new Thickness(0, 0, 0, 16) });
        connectionModeBox = new ComboBox { DisplayMemberPath = "Label", SelectedValuePath = "Value", ItemsSource = new[] { new Choice { Value = "local", Label = "本地运行（当前电脑）" }, new Choice { Value = "remote", Label = "远程服务器（SSH）" } }, Margin = new Thickness(0, 0, 0, 14) };
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionModeBox, "Connection-Mode");
        connectionModeBox.SelectedValue = connectionMode;
        panel.Children.Add(connectionModeBox);
        panel.Children.Add(new TextBlock { Text = "服务器配置", FontSize = 11, Margin = new Thickness(0, 0, 0, 6) });
        var profileRow = new Grid(); profileRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); profileRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); profileRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        connectionProfileBox = new ComboBox { DisplayMemberPath = "Name", Margin = new Thickness(0, 0, 8, 0) };
        connectionNewButton = new Button { Content = "新建", Margin = new Thickness(0, 0, 8, 0) }; connectionDeleteButton = new Button { Content = "删除" };
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionProfileBox, "Connection-Profile");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionNewButton, "Connection-New");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionDeleteButton, "Connection-Delete");
        Grid.SetColumn(connectionNewButton, 1); Grid.SetColumn(connectionDeleteButton, 2);
        profileRow.Children.Add(connectionProfileBox); profileRow.Children.Add(connectionNewButton); profileRow.Children.Add(connectionDeleteButton); panel.Children.Add(profileRow);
        Action<string, TextBox> addField = (label, box) => { panel.Children.Add(new TextBlock { Text = label, FontSize = 11, Margin = new Thickness(0, 12, 0, 5) }); panel.Children.Add(box); };
        connectionName = new TextBox { Tag = "例如：家庭服务器" };
        connectionHost = new TextBox { Tag = "服务器 IP 或域名" };
        connectionPort = new TextBox { Text = "22", Tag = "22" };
        connectionUser = new TextBox { Tag = "登录服务器使用的账户" };
        connectionNode = new TextBox { Text = "node", Tag = "node 或服务器上的 Node 完整路径" };
        connectionProgram = new TextBox { Text = "/opt/whaleworkbench/current", Tag = "/opt/whaleworkbench/current" };
        connectionData = new TextBox { Text = "/var/lib/whaleworkbench", Tag = "/var/lib/whaleworkbench" };
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionName, "Connection-Name");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionHost, "Connection-Host");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionPort, "Connection-Port");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionUser, "Connection-User");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionNode, "Connection-Node");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionProgram, "Connection-Program");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionData, "Connection-Data");
        addField("连接名称", connectionName);
        addField("服务器地址", connectionHost);
        addField("SSH 端口", connectionPort);
        addField("登录用户", connectionUser);
        panel.Children.Add(new TextBlock { Text = "SSH 私钥", FontSize = 11, Margin = new Thickness(0, 12, 0, 5) });
        var keyRow = new DockPanel(); connectionBrowseKey = new Button { Content = "浏览…", Margin = new Thickness(8, 0, 0, 0) }; DockPanel.SetDock(connectionBrowseKey, Dock.Right);
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionBrowseKey, "Connection-BrowseKey");
        connectionKey = new TextBox { Tag = "可留空，使用 SSH 默认密钥" }; keyRow.Children.Add(connectionBrowseKey); keyRow.Children.Add(connectionKey); panel.Children.Add(keyRow);
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionKey, "Connection-Key");
        addField("服务器 Node 命令或路径", connectionNode);
        addField("服务器程序目录", connectionProgram);
        addField("服务器数据目录", connectionData);
        connectionKeyStatus = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 11, Foreground = Ink("Muted"), LineHeight = 18, Margin = new Thickness(0, 16, 0, 0) }; panel.Children.Add(connectionKeyStatus);
        connectionStatusText = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 11, LineHeight = 19, Margin = new Thickness(0, 10, 0, 0) }; panel.Children.Add(connectionStatusText);
        connectionErrorText = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Ink("Danger"), FontSize = 11, Visibility = Visibility.Collapsed, Margin = new Thickness(0, 10, 0, 0) }; panel.Children.Add(connectionErrorText);
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionKeyStatus, "Connection-KeyStatus");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionStatusText, "Connection-Status");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionErrorText, "Connection-Error");
        var actions = new WrapPanel { Margin = new Thickness(0, 18, 0, 0) };
        connectionConnectButton = new Button { Content = "连接服务器", Style = (Style)window.FindResource("Primary"), Margin = new Thickness(0, 0, 8, 8) };
        connectionSaveButton = new Button { Content = "仅保存配置", Margin = new Thickness(0, 0, 8, 8) };
        connectionDisconnectButton = new Button { Content = "断开连接", Style = (Style)window.FindResource("Quiet"), Margin = new Thickness(0, 0, 8, 8) };
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionConnectButton, "Connection-Connect");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionSaveButton, "Connection-Save");
        System.Windows.Automation.AutomationProperties.SetAutomationId(connectionDisconnectButton, "Connection-Disconnect");
        actions.Children.Add(connectionConnectButton); actions.Children.Add(connectionSaveButton); actions.Children.Add(connectionDisconnectButton); panel.Children.Add(actions);
        panel.Children.Add(new TextBlock { Text = "主机密钥首次连接时会显示 SHA256 指纹，必须手动确认；之后发生变化会再次要求确认，不会静默接受。私钥只保存在本机。", TextWrapping = TextWrapping.Wrap, Foreground = Ink("Muted"), FontSize = 11, LineHeight = 18, Margin = new Thickness(0, 6, 0, 0) });
        connectionDialog.Content = new Border { Padding = new Thickness(24), Background = window.Background, Child = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } };
        connectionModeBox.SelectionChanged += (s, e) => { if (!loadingConnectionForm) RefreshConnectionDialog(); };
        connectionProfileBox.SelectionChanged += (s, e) => {
            if (loadingConnectionForm) return;
            CaptureProfileForm(editingProfile);
            editingProfile = connectionProfileBox.SelectedItem as RemoteProfile;
            LoadProfileForm(editingProfile);
        };
        connectionNewButton.Click += (s, e) => {
            CaptureProfileForm(editingProfile);
            var profile = new RemoteProfile { Id = Guid.NewGuid().ToString("N"), Name = "服务器 " + (remoteConfig.Profiles.Count + 1), Port = 22, Node = "node", Program = "/opt/whaleworkbench/current", DataDir = "/var/lib/whaleworkbench" };
            remoteConfig.Profiles.Add(profile);
            remoteConfig.Active = profile.Id;
            SaveConnectionConfig();
            ReloadProfileList(profile.Id);
            Feedback("已新建服务器配置，请填写后保存或连接。");
        };
        connectionDeleteButton.Click += (s, e) => { DeleteProfile(); };
        connectionBrowseKey.Click += (s, e) => { var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "SSH 私钥|*|所有文件|*.*" }; if (dialog.ShowDialog(connectionDialog) == true) connectionKey.Text = dialog.FileName; };
        connectionSaveButton.Click += (s, e) => { string error = SaveFormProfile(); if (error != null) ShowConnectionError(error); else { RefreshConnectionDialog(); Feedback("服务器连接配置已保存。"); } };
        connectionConnectButton.Click += (s, e) => ConnectFromDialog();
        connectionDisconnectButton.Click += (s, e) => { DisconnectRemote(); RefreshConnectionDialog(); };
        connectionDialog.Closed += (s, e) => {
            connectionDialog = null; connectionModeBox = null; connectionProfileBox = null;
            connectionName = connectionHost = connectionPort = connectionUser = connectionKey = connectionNode = connectionProgram = connectionData = null;
            connectionStatusText = connectionKeyStatus = connectionErrorText = null;
            connectionConnectButton = connectionSaveButton = connectionDisconnectButton = connectionDeleteButton = connectionNewButton = connectionBrowseKey = null;
        };
        if (remoteConfig.Profiles.Count == 0) {
            var profile = new RemoteProfile { Id = Guid.NewGuid().ToString("N"), Name = "服务器 1", Port = 22, Node = "node", Program = "/opt/whaleworkbench/current", DataDir = "/var/lib/whaleworkbench" };
            remoteConfig.Profiles.Add(profile); remoteConfig.Active = profile.Id;
        }
        ReloadProfileList(remoteConfig.Active);
        if (preview) connectionDialog.Show(); else connectionDialog.ShowDialog();
    }

    static void ReloadProfileList(string id) {
        if (connectionProfileBox == null) return;
        loadingConnectionForm = true;
        connectionProfileBox.ItemsSource = null;
        connectionProfileBox.ItemsSource = remoteConfig.Profiles;
        var profile = remoteConfig.Profiles.FirstOrDefault(item => item.Id == id) ?? remoteConfig.Profiles.FirstOrDefault();
        connectionProfileBox.SelectedItem = profile;
        editingProfile = profile;
        LoadProfileForm(profile);
        loadingConnectionForm = false;
        RefreshConnectionDialog();
    }

    static RemoteProfile editingProfile;

    static void CaptureProfileForm(RemoteProfile profile) {
        if (profile == null || loadingConnectionForm || connectionName == null) return;
        profile.Name = connectionName.Text.Trim();
        profile.Host = connectionHost.Text.Trim();
        int port;
        profile.Port = int.TryParse(connectionPort.Text.Trim(), out port) ? port : 0;
        profile.User = connectionUser.Text.Trim();
        profile.KeyFile = connectionKey.Text.Trim();
        profile.Node = connectionNode.Text.Trim();
        profile.Program = connectionProgram.Text.Trim();
        profile.DataDir = connectionData.Text.Trim();
    }

    static void LoadProfileForm(RemoteProfile profile) {
        if (connectionName == null) return;
        loadingConnectionForm = true;
        if (profile == null) {
            connectionName.Text = connectionHost.Text = connectionPort.Text = connectionUser.Text = connectionKey.Text = "";
            connectionNode.Text = "node"; connectionProgram.Text = "/opt/whaleworkbench/current"; connectionData.Text = "/var/lib/whaleworkbench";
        } else {
            connectionName.Text = profile.Name ?? "";
            connectionHost.Text = profile.Host ?? "";
            connectionPort.Text = profile.Port > 0 ? profile.Port.ToString(CultureInfo.InvariantCulture) : "22";
            connectionUser.Text = profile.User ?? "";
            connectionKey.Text = profile.KeyFile ?? "";
            connectionNode.Text = string.IsNullOrWhiteSpace(profile.Node) ? "node" : profile.Node;
            connectionProgram.Text = profile.Program ?? "";
            connectionData.Text = profile.DataDir ?? "";
        }
        loadingConnectionForm = false;
        RefreshConnectionDialog();
    }

    static string SaveFormProfile() {
        CaptureProfileForm(editingProfile);
        string error = ValidateProfile(editingProfile, false);
        if (error != null) return error;
        remoteConfig.Active = editingProfile.Id;
        remoteConfig.Mode = DialogRemoteMode() ? "remote" : "local";
        SaveConnectionConfig();
        ReloadProfileList(editingProfile.Id);
        return null;
    }

    static void DeleteProfile() {
        CaptureProfileForm(editingProfile);
        if (editingProfile == null) return;
        if (MessageBox.Show(connectionDialog ?? window, "删除连接配置“" + (editingProfile.Name ?? "") + "”？如果正在连接，会先断开。服务器上的机器人与数据不会被删除。", "删除服务器配置", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        if (connectionMode == "remote" && remoteConfig.Active == editingProfile.Id) DisconnectRemote();
        remoteConfig.Profiles.Remove(editingProfile);
        remoteConfig.Active = remoteConfig.Profiles.Count > 0 ? remoteConfig.Profiles[0].Id : "";
        SaveConnectionConfig();
        ReloadProfileList(remoteConfig.Active);
        Feedback("服务器配置已删除。");
    }

    static void ShowConnectionError(string text) {
        if (connectionErrorText == null) return;
        connectionErrorText.Text = text ?? "";
        connectionErrorText.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
    }

    static bool DialogRemoteMode() {
        if (connectionModeBox == null) return connectionMode == "remote";
        var choice = connectionModeBox.SelectedItem as Choice;
        return choice != null ? choice.Value == "remote" : Convert.ToString(connectionModeBox.SelectedValue) == "remote";
    }

    static void RefreshConnectionDialog() {
        if (connectionDialog == null || connectionModeBox == null) return;
        bool remote = DialogRemoteMode();
        bool busy = hostKeyBusy;
        foreach (var control in new Control[] { connectionName, connectionHost, connectionPort, connectionUser, connectionKey, connectionNode, connectionProgram, connectionData }) if (control != null) control.IsEnabled = remote && !busy;
        if (connectionProfileBox != null) connectionProfileBox.IsEnabled = remote && !busy && remoteConfig.Profiles.Count > 0;
        if (connectionNewButton != null) connectionNewButton.IsEnabled = remote && !busy;
        if (connectionDeleteButton != null) connectionDeleteButton.IsEnabled = remote && !busy && editingProfile != null;
        if (connectionBrowseKey != null) connectionBrowseKey.IsEnabled = remote && !busy;
        if (connectionSaveButton != null) connectionSaveButton.IsEnabled = remote && !busy && editingProfile != null;
        if (connectionConnectButton != null) {
            connectionConnectButton.IsEnabled = !busy;
            connectionConnectButton.Content = remote ? (remoteDesired && host != null && !host.HasExited ? "重新连接服务器" : "连接服务器") : "切换到本地模式";
        }
        if (connectionDisconnectButton != null) connectionDisconnectButton.IsEnabled = !busy && connectionMode == "remote" && host != null && !host.HasExited;
        if (remote) {
            if (editingProfile == null) connectionKeyStatus.Text = "尚未选择服务器配置。";
            else if (HostKeyPinned(editingProfile)) connectionKeyStatus.Text = "已保存主机密钥" + (string.IsNullOrEmpty(editingProfile.Fingerprint) ? "。" : "：\n" + editingProfile.Fingerprint);
            else connectionKeyStatus.Text = "尚未确认主机密钥；首次连接时会显示 SHA256 指纹供你核对。";
            connectionStatusText.Text = connectionMode == "remote" ? (remoteConnecting ? "正在连接服务器…" : remoteDesired && host != null && !host.HasExited ? (remoteEverConnected ? "控制台已连接到服务器。" : "正在连接服务器…") : (remoteStatus.Length > 0 ? remoteStatus : "尚未连接服务器。")) : "当前使用本地模式。";
        } else {
            connectionKeyStatus.Text = "本地模式不需要 SSH 主机密钥。";
            connectionStatusText.Text = "当前使用本地模式；机器人与控制台在同一台电脑上运行。";
        }
    }

    static void ConnectFromDialog() {
        if (hostKeyBusy) return;
        string error = SaveFormProfile();
        if (error != null) { ShowConnectionError(error); return; }
        ShowConnectionError(null);
        if (remoteConfig.Mode != "remote") { SwitchToLocal(); RefreshConnectionDialog(); return; }
        var profile = editingProfile;
        hostKeyBusy = true;
        if (connectionStatusText != null) connectionStatusText.Text = "正在读取服务器主机密钥…";
        RefreshConnectionDialog();
        HostKeyScan scan;
        try { scan = ScanHostKeys(profile); } finally { hostKeyBusy = false; }
        if (scan.Error != null) { ShowConnectionError(scan.Error); RefreshConnectionDialog(); return; }
        if (!ConfirmHostKey(profile, scan)) { ShowConnectionError("已取消：未确认服务器主机密钥，未连接服务器。"); RefreshConnectionDialog(); return; }
        SaveHostKey(profile, scan.Lines, scan.Fingerprint);
        ConnectToRemote(profile);
        RefreshConnectionDialog();
    }

    static void VerifyConnectionInteraction() {
        OpenServerConnection(true);
        try {
            if (connectionModeBox.SelectedValue as string != "local") throw new Exception("服务器连接默认不是本地模式");
            if (connectionConnectButton.Content as string != "切换到本地模式") throw new Exception("本地模式的连接按钮不正确");
            if (connectionHost.IsEnabled) throw new Exception("本地模式下服务器字段仍可编辑");
            connectionModeBox.SelectedValue = "remote";
            if (!connectionHost.IsEnabled || !connectionNewButton.IsEnabled) throw new Exception("远程模式字段未启用");
            connectionName.Text = "Fixture server"; connectionHost.Text = "127.0.0.1"; connectionPort.Text = "1"; connectionUser.Text = "fixture";
            connectionNode.Text = "node"; connectionProgram.Text = "/opt/whaleworkbench/current"; connectionData.Text = "/var/lib/whaleworkbench";
            CaptureProfileForm(editingProfile);
            if (ValidateProfile(editingProfile, false) != null) throw new Exception("有效的服务器配置未通过校验");
            connectionHost.Text = "bad host"; CaptureProfileForm(editingProfile);
            if (ValidateProfile(editingProfile, false) == null) throw new Exception("服务器地址允许空白或特殊字符");
            connectionHost.Text = "127.0.0.1"; CaptureProfileForm(editingProfile);
            RefreshConnectionDialog();
            connectionDialog.UpdateLayout(); CaptureContent((FrameworkElement)connectionDialog.Content, Path.Combine(root, "server-connection.png"));
        } finally {
            if (connectionDialog != null) connectionDialog.Close();
            connectionDialog = null;
        }
        if (connectionMode != "local") throw new Exception("服务器连接预览改变了运行模式");
    }
}
