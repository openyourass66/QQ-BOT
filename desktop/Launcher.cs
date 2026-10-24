using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "desktop", "start.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show("请将 EXE 保留在 QQ-BOT 文件夹中，desktop 目录不可缺失。", "小鲸鱼控制台");
            return;
        }
        try
        {
            var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"));
            info.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File \"" + script + "\"";
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            using (var process = Process.Start(info)) { process.WaitForExit(); }
        }
        catch (Exception error) { MessageBox.Show(error.Message, "小鲸鱼控制台启动失败"); }
    }
}
