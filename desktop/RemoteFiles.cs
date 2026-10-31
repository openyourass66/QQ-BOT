using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows;

partial class App
{
    // 远程文件的生成与上传都在服务器暂存目录完成；本机只负责选择本地位置和传输。
    static Process remoteTransfer;
    static Action<bool, string> remoteTransferDone;

    static bool RemoteModeActive() {
        return connectionMode == "remote" && host != null && !host.HasExited;
    }

    static string RemoteStagingDirectory(RemoteProfile profile) {
        return profile.DataDir.TrimEnd('/') + "/data/desktop/staging";
    }

    static string RemoteTempPath(string prefix, string extension) {
        return "/tmp/" + RemoteFileName(prefix, extension);
    }

    static string RemoteFileName(string prefix, string extension) {
        return prefix + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + extension;
    }

    static string ShellQuote(string value) {
        return "'" + value + "'";
    }

    static List<string> RemoteShellArgumentList(RemoteProfile profile, string command) {
        var args = new List<string> { "-T" };
        if (!string.IsNullOrEmpty(profile.KeyFile)) { args.Add("-o"); args.Add("IdentitiesOnly=yes"); args.Add("-i"); args.Add(QuoteArgument(profile.KeyFile)); }
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
        args.Add(QuoteArgument(command));
        return args;
    }

    static List<string> ScpArgumentList(RemoteProfile profile, bool upload, string localPath, string remotePath) {
        var args = new List<string> { "-q" };
        if (!string.IsNullOrEmpty(profile.KeyFile)) { args.Add("-o"); args.Add("IdentitiesOnly=yes"); args.Add("-i"); args.Add(QuoteArgument(profile.KeyFile)); }
        args.Add("-o"); args.Add("BatchMode=yes");
        args.Add("-o"); args.Add("StrictHostKeyChecking=yes");
        args.Add("-o"); args.Add("GlobalKnownHostsFile=NUL");
        args.Add("-o"); args.Add("UpdateHostKeys=no");
        args.Add("-o"); args.Add("UserKnownHostsFile=" + QuoteArgument(knownHostsPath));
        args.Add("-o"); args.Add("ConnectTimeout=10");
        args.Add("-o"); args.Add("ServerAliveInterval=15");
        args.Add("-o"); args.Add("ServerAliveCountMax=3");
        args.Add("-o"); args.Add("LogLevel=ERROR");
        args.Add("-P"); args.Add(profile.Port.ToString(CultureInfo.InvariantCulture));
        string remote = profile.User + "@" + profile.Host + ":" + remotePath;
        if (upload) { args.Add(QuoteArgument(localPath)); args.Add(QuoteArgument(remote)); }
        else { args.Add(QuoteArgument(remote)); args.Add(QuoteArgument(localPath)); }
        return args;
    }

    static bool ValidTransferPath(string remotePath) {
        return SafeRemotePath(remotePath) && !remotePath.Contains(":");
    }

    static bool EnsureRemoteDirectory(RemoteProfile profile, string directory, out string error) {
        error = null;
        if (!ValidTransferPath(directory)) { error = "服务器暂存目录格式无效。"; return false; }
        string stderr;
        string output = RunCapture(SshTool("ssh"), string.Join(" ", RemoteShellArgumentList(profile, "mkdir -p " + ShellQuote(directory))), 20000, out stderr);
        if (output == null) { error = ShortError(stderr); return false; }
        return true;
    }

    static void DeleteRemoteFileQuiet(RemoteProfile profile, string remotePath) {
        if (profile == null || string.IsNullOrEmpty(remotePath) || !ValidTransferPath(remotePath)) return;
        string stderr;
        RunCapture(SshTool("ssh"), string.Join(" ", RemoteShellArgumentList(profile, "rm -f -- " + ShellQuote(remotePath))), 15000, out stderr);
    }

    static bool RemoteFileExists(RemoteProfile profile, string remotePath) {
        if (profile == null || !ValidTransferPath(remotePath)) return false;
        string stderr;
        string output = RunCapture(SshTool("ssh"), string.Join(" ", RemoteShellArgumentList(profile, "test -f " + ShellQuote(remotePath) + " && echo FILE_OK")), 15000, out stderr);
        return output != null && output.IndexOf("FILE_OK", StringComparison.Ordinal) >= 0;
    }

    /** 本机界面使用的异步传输：完成后经 Dispatcher 回到界面线程。 */
    static void BeginRemoteTransfer(RemoteProfile profile, bool upload, string localPath, string remotePath, Action<bool, string> done) {
        if (profile == null || !RemoteModeActive()) { done(false, "尚未连接服务器，无法传输文件。"); return; }
        if (remoteTransfer != null) { done(false, "已有文件传输正在进行，请稍候。"); return; }
        if (!ValidTransferPath(remotePath)) { done(false, "服务器文件路径包含不支持的字符。"); return; }
        var info = new ProcessStartInfo(SshTool("scp"), string.Join(" ", ScpArgumentList(profile, upload, localPath, remotePath))) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        var errors = new StringBuilder();
        bool completed = false;
        Action<bool, string> finish = (ok, message) => {
            if (completed) return;
            completed = true;
            if (remoteTransfer == process) { remoteTransfer = null; remoteTransferDone = null; }
            try { process.Dispose(); } catch { }
            try { if (window != null) window.Dispatcher.BeginInvoke((Action)(() => done(ok, message))); else done(ok, message); } catch { done(ok, message); }
        };
        remoteTransfer = process;
        remoteTransferDone = finish;
        process.ErrorDataReceived += (s, e) => { if (e.Data != null) errors.AppendLine(e.Data); };
        process.OutputDataReceived += (s, e) => { };
        process.Exited += (s, e) => finish(process.ExitCode == 0, ShortError(errors.ToString()));
        try {
            process.Start();
            process.BeginErrorReadLine();
            process.BeginOutputReadLine();
        } catch (Exception error) {
            finish(false, error.Message);
        }
    }

    static bool CancelRemoteTransfer() {
        var process = remoteTransfer;
        var finish = remoteTransferDone;
        if (process == null || finish == null) return false;
        try { process.Kill(); } catch { }
        finish(false, "传输已取消。");
        return true;
    }

    static string RunScp(RemoteProfile profile, bool upload, string localPath, string remotePath, int timeoutMs, out string error) {
        error = "服务器文件路径包含不支持的字符。";
        if (!ValidTransferPath(remotePath)) return null;
        return RunCapture(SshTool("scp"), string.Join(" ", ScpArgumentList(profile, upload, localPath, remotePath)), timeoutMs, out error);
    }

    static void DownloadServerLog() {
        var profile = ActiveRemoteProfile();
        if (profile == null || !RemoteModeActive()) { Feedback("请先连接服务器后再下载日志。"); return; }
        string remoteLog = profile.DataDir.TrimEnd('/') + "/data/desktop/console.log";
        if (!RemoteFileExists(profile, remoteLog)) { Feedback("服务器上还没有日志文件，请启动机器人后再试。"); return; }
        var picker = new Microsoft.Win32.SaveFileDialog { Title = "保存服务器运行日志", Filter = "文本日志|*.txt", DefaultExt = ".txt", FileName = "服务器运行日志-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".txt" };
        if (picker.ShowDialog(window) != true) return;
        string local = picker.FileName;
        Feedback("正在下载服务器日志…");
        BeginRemoteTransfer(profile, false, local, remoteLog, (ok, message) => {
            Feedback(ok ? "服务器日志已下载：" + local : "下载服务器日志失败：" + message);
        });
    }

    /** 冒烟检查：验证 scp 链路与暂存目录，使用独立的临时文件，不影响运行数据。 */
    static void VerifyRemoteFilesInteraction() {
        if (!RemoteModeActive()) return;
        var profile = ActiveRemoteProfile();
        if (profile == null) throw new Exception("远程模式下缺少可用的服务器配置");
        string directory = RemoteStagingDirectory(profile);
        string error;
        if (!EnsureRemoteDirectory(profile, directory, out error)) throw new Exception("无法准备服务器暂存目录：" + error);
        string local = Path.Combine(Path.GetTempPath(), "whale-transfer-" + Guid.NewGuid().ToString("N") + ".txt");
        string download = local + ".downloaded";
        string remote = directory + "/transfer-" + Guid.NewGuid().ToString("N") + ".txt";
        try {
            File.WriteAllText(local, "remote-transfer-fixture", new UTF8Encoding(false));
            if (RunScp(profile, true, local, remote, 60000, out error) == null) throw new Exception("上传测试文件失败：" + ShortError(error));
            if (RunScp(profile, false, download, remote, 60000, out error) == null) throw new Exception("下载测试文件失败：" + ShortError(error));
            if (File.ReadAllText(download, Encoding.UTF8) != "remote-transfer-fixture") throw new Exception("远程传输内容不一致");
        } finally {
            DeleteRemoteFileQuiet(profile, remote);
            try { File.Delete(local); } catch { }
            try { File.Delete(download); } catch { }
        }
    }
}
