using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

class App
{
    static Window window;
    static Process host;
    static StreamWriter hostInput;
    static string root;
    static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4194304 };
    static ConcurrentQueue<string> events = new ConcurrentQueue<string>();
    static Dictionary<string, Control> fields = new Dictionary<string, Control>();
    static Dictionary<string, object> settings;
    static Queue<string> logs = new Queue<string>();
    static bool exiting, paused, dirty, loading, hostFailed;
    static HashSet<string> dirtySections = new HashSet<string>();
    static string personaPath;
    static Forms.NotifyIcon tray;
    static EventWaitHandle restore;
    static Dictionary<string, string> labels = new Dictionary<string, string> {
        {"identity", "身份"}, {"name", "机器人名称"}, {"chat", "对话"}, {"privateAutoReply", "自动回复私聊"}, {"group", "群聊"}, {"requireMention", "需要 @ 或前缀"}, {"prefix", "触发前缀"}, {"cooldownMs", "旁聊冷却（毫秒）"}, {"contextLines", "群聊摘要行数"}, {"followUpMs", "追问窗口（毫秒）"}, {"proactive", "主动发言"}, {"enabled", "启用"}, {"perGroupPerDay", "每群每日额度"}, {"delay", "回复节奏"}, {"minMs", "最短延迟（毫秒）"}, {"maxMs", "最长延迟（毫秒）"}, {"chunkSize", "分片字符数"}, {"approval", "审批"}, {"adminQq", "管理员 QQ"}, {"allowExec", "自动允许执行命令"}, {"timeoutMs", "审批超时（毫秒）"}, {"features", "功能"}, {"qzone", "QQ 空间"}, {"dailyLimit", "每日额度"}, {"requireConfirm", "发布前确认"}, {"browsing", "浏览器（暂未接入）"}, {"maxNavigations", "最大导航次数"}, {"maxScreenshots", "最大截图次数"}, {"budgets", "每日额度"}, {"proactiveMessagesPerDay", "主动消息数"}, {"likesPerDay", "点赞次数"}
    };
    static T Find<T>(string name) where T : class { return window.FindName(name) as T; }
    static string Label(string key) { return labels.ContainsKey(key) ? labels[key] : key; }
    static void Feedback(string text) { Find<TextBlock>("Feedback").Text = text; Find<TextBlock>("Feedback").ToolTip = text; }
    static void Send(string action, object data = null) {
        try { if (host == null || host.HasExited) throw new Exception(); hostInput.WriteLine(json.Serialize(new { action = action, data = data })); hostInput.Flush(); }
        catch { Feedback("控制进程不可用，请退出后重新打开控制台。"); }
    }
    static void Restore() { window.Show(); window.WindowState = WindowState.Normal; window.Activate(); }
    static void MarkDirty(string section) { if (!loading) { dirtySections.Add(section); dirty = true; } }
    static void EditChanged(object sender, TextChangedEventArgs e) { MarkDirty(sender == Find<TextBox>("Env") ? "env" : sender == Find<TextBox>("Persona") ? "persona" : "settings"); }
    static void MakeFields(Dictionary<string, object> data, string prefix, StackPanel panel) {
        foreach (var pair in data) {
            string path = prefix + pair.Key;
            var nested = pair.Value as Dictionary<string, object>;
            if (nested != null) {
                panel.Children.Add(new TextBlock { Text = Label(pair.Key), FontSize = 17, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 18, 0, 10) });
                MakeFields(nested, path + ".", panel); continue;
            }
            var row = new Grid { Margin = new Thickness(0, 0, 10, 10) };
            row.ColumnDefinitions.Add(new ColumnDefinition()); row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(240) });
            var label = new TextBlock { Text = Label(pair.Key), VerticalAlignment = VerticalAlignment.Center, ToolTip = path };
            row.Children.Add(label);
            Control input;
            if (pair.Value is bool) {
                var check = new CheckBox { IsChecked = (bool)pair.Value, Content = "开启", ToolTip = path };
                check.Checked += (s, e) => MarkDirty("settings"); check.Unchecked += (s, e) => MarkDirty("settings"); input = check;
            } else {
                var text = new TextBox { Text = Convert.ToString(pair.Value, System.Globalization.CultureInfo.InvariantCulture), ToolTip = path };
                text.TextChanged += EditChanged; input = text;
            }
            System.Windows.Automation.AutomationProperties.SetName(input, Label(pair.Key));
            fields[path] = input; Grid.SetColumn(input, 1); row.Children.Add(input); panel.Children.Add(row);
        }
    }
    static Dictionary<string, object> Collect(Dictionary<string, object> original, string prefix) {
        var result = new Dictionary<string, object>();
        foreach (var pair in original) {
            string path = prefix + pair.Key;
            var nested = pair.Value as Dictionary<string, object>;
            if (nested != null) result[pair.Key] = Collect(nested, path + ".");
            else if (pair.Value is bool) result[pair.Key] = ((CheckBox)fields[path]).IsChecked == true;
            else if (pair.Value is string) result[pair.Key] = ((TextBox)fields[path]).Text;
            else {
                long number;
                if (!long.TryParse(((TextBox)fields[path]).Text, out number)) { fields[path].Focus(); throw new Exception(Label(pair.Key) + "必须是整数"); }
                result[pair.Key] = number;
            }
        }
        return result;
    }
    static void Exit() {
        if (exiting) return;
        if (dirty && MessageBox.Show(window, "有尚未保存的编辑，仍要退出吗？", "小鲸提醒", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        exiting = true; window.Show(); Feedback("正在保存运行数据并停止机器人，请稍候…");
        window.IsEnabled = false; Send("quit");
    }
    static void Event(string line) {
        var message = json.Deserialize<Dictionary<string, object>>(line);
        string type = (string)message["type"];
        if (type == "log") {
            logs.Enqueue((string)message["text"]); while (logs.Count > 1500) logs.Dequeue();
        } else if (type == "error") Feedback((string)message["text"]);
        else if (type == "saved") { dirtySections.Remove((string)message["section"]); dirty = dirtySections.Count > 0; Feedback("保存成功。动态设置即时生效；连接参数需重启，人设在新会话生效。"); }
        else if (type == "config") {
            loading = true;
            settings = (Dictionary<string, object>)message["settings"];
            var panel = Find<StackPanel>("Fields"); panel.Children.Clear(); fields.Clear(); MakeFields(settings, "", panel);
            Find<TextBox>("Env").Text = (string)message["env"];
            Find<TextBox>("Persona").Text = (string)message["persona"];
            personaPath = (string)message["personaPath"];
            Find<TextBlock>("PersonaHint").Text = "人设：" + personaPath + "\n保存后新会话生效；记忆可从目录中管理。";
            loading = false; dirty = false; Find<Button>("SaveSettings").IsEnabled = true;
            Feedback("配置已加载，小鲸准备好了。");
        } else if (type == "state") {
            bool bridge = (bool)message["bridge"], napcat = (bool)message["napcat"], busy = (bool)message["busy"];
            Find<TextBlock>("State").Text = busy ? "小鲸正在安排工作…" : bridge && napcat ? "小鲸已出发，等待连接就绪" : bridge || napcat ? "部分进程运行中，请查看日志" : "小鲸休息中，随时可以出发";
            Find<Button>("Start").IsEnabled = !busy && !(bridge && napcat); Find<Button>("Stop").IsEnabled = !busy && (bridge || napcat); Find<Button>("Restart").IsEnabled = !busy;
            if (!bridge) Find<TextBlock>("Stats").Text = "桥接已停止 · NapCat " + (napcat ? "运行中" : "已停止");
        } else if (type == "status") {
            bool online = (bool)message["qqOnline"] && (bool)message["wsConnected"] && (bool)message["acpConnected"];
            Find<TextBlock>("State").Text = online ? "小鲸在线，正在认真陪伴" : "进程运行中，等待 QQ / 模型连接";
            Find<TextBlock>("Stats").Text = "QQ " + ((bool)message["qqOnline"] ? "在线" : "离线") + "  ·  模型 " + ((bool)message["acpConnected"] ? "已连接" : "未连接") + "  ·  收到 " + message["messagesIn"] + " / 发出 " + message["messagesOut"] + "  ·  排队 " + message["pendingMessages"];
        }
    }
    [STAThread] static void Main(string[] args) {
        root = AppDomain.CurrentDomain.BaseDirectory;
        bool owner;
        string id = BitConverter.ToString(System.Security.Cryptography.SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
        using (var mutex = new Mutex(true, "Local\\QQBotDesktop-" + id, out owner)) {
            restore = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\QQBotRestore-" + id);
            if (!owner) { restore.Set(); return; }
            try { Run(args); } catch (Exception e) { MessageBox.Show(e.Message, "小鲸控制台启动失败"); }
            finally { if (tray != null) tray.Dispose(); if (host != null) { try { host.StandardInput.Close(); } catch {} } restore.Dispose(); mutex.ReleaseMutex(); }
        }
    }
    static void Run(string[] args) {
        bool smoke = args.Length > 0 && args[0] == "--smoke";
        int smokeStep = 0;
        DateTime smokeDeadline = DateTime.UtcNow.AddSeconds(20);
        window = (Window)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/window.xaml"), Encoding.UTF8));
        string icon = Path.Combine(root, "QQ-BOT.ico");
        if (File.Exists(icon)) window.Icon = System.Windows.Media.Imaging.BitmapFrame.Create(new Uri(icon));
        if (args.Length > 0 && args[0] == "--preview") {
            window.Show(); window.UpdateLayout();
            var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(window);
            var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder(); encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
            using (var output = File.Create(args[1])) encoder.Save(output); window.Close(); return;
        }
        var info = new ProcessStartInfo("node.exe", "\"" + Path.Combine(root, "desktop/host.mjs") + "\"") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        host = new Process { StartInfo = info, EnableRaisingEvents = true };
        host.OutputDataReceived += (s, e) => { if (e.Data != null) events.Enqueue(e.Data); };
        host.ErrorDataReceived += (s, e) => { if (e.Data != null) events.Enqueue("{\"type\":\"error\",\"text\":\"控制进程异常，请检查配置与 Node 版本。\"}"); };
        host.Start(); hostInput = new StreamWriter(host.StandardInput.BaseStream, new UTF8Encoding(false)); host.BeginOutputReadLine(); host.BeginErrorReadLine();
        tray = new Forms.NotifyIcon { Text = "小鲸 · QQ 机器人", Icon = File.Exists(icon) ? new System.Drawing.Icon(icon) : System.Drawing.SystemIcons.Application, Visible = true };
        var menu = new Forms.ContextMenuStrip(); menu.Items.Add("打开小鲸工作台", null, (s, e) => Restore()); menu.Items.Add("启动机器人", null, (s, e) => Send("start")); menu.Items.Add("停止机器人", null, (s, e) => Send("stop")); menu.Items.Add(new Forms.ToolStripSeparator()); menu.Items.Add("退出并停止机器人", null, (s, e) => Exit()); tray.ContextMenuStrip = menu;
        tray.MouseClick += (s, e) => { if (e.Button == Forms.MouseButtons.Left) Restore(); };
        window.Closing += (s, e) => { if (!exiting) { e.Cancel = true; window.Hide(); tray.ShowBalloonTip(2000, "小鲸还在这里", "机器人继续运行，点击托盘图标恢复窗口。", Forms.ToolTipIcon.Info); } };
        Find<Button>("Start").Click += (s, e) => Send("start"); Find<Button>("Stop").Click += (s, e) => Send("stop"); Find<Button>("Restart").Click += (s, e) => Send("restart");
        Find<Button>("Pause").Click += (s, e) => { paused = !paused; Find<Button>("Pause").Content = paused ? "继续滚动" : "暂停滚动"; };
        Find<Button>("Clear").Click += (s, e) => { logs.Clear(); Find<TextBox>("Logs").Clear(); };
        Find<Button>("SaveSettings").IsEnabled = false;
        Find<Button>("SaveSettings").Click += (s, e) => { try { Send("settings", Collect(settings, "")); } catch (Exception error) { Feedback(error.Message); } };
        Find<Button>("SaveEnv").Click += (s, e) => Send("env", Find<TextBox>("Env").Text);
        Find<Button>("SavePersona").Click += (s, e) => Send("persona", new { text = Find<TextBox>("Persona").Text, path = personaPath });
        Find<Button>("Memory").Click += (s, e) => { try { string path = Path.Combine(Path.GetDirectoryName(personaPath), "memory"); Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { Feedback("无法打开记忆目录，请先加载配置。"); } };
        Find<TextBox>("Env").TextChanged += EditChanged; Find<TextBox>("Persona").TextChanged += EditChanged;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
        timer.Tick += (s, e) => {
            if (restore.WaitOne(0)) Restore();
            string line; int count = 0; while (count++ < 300 && events.TryDequeue(out line)) { try { Event(line); } catch { Feedback("收到无效的控制消息。"); } }
            if (!paused) { var text = string.Join(Environment.NewLine, logs); if (Find<TextBox>("Logs").Text != text) { Find<TextBox>("Logs").Text = text; Find<TextBox>("Logs").ScrollToEnd(); } }
            if (host.HasExited) { if (exiting) { timer.Stop(); window.Close(); } else if (!hostFailed) { hostFailed = true; Find<TextBlock>("State").Text = "控制进程已退出"; Feedback("请退出并重新打开控制台。"); } }
            if (smoke && !exiting) {
                if (DateTime.UtcNow > smokeDeadline) { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "FAIL: lifecycle timeout"); exiting = true; Send("quit"); return; }
                if (smokeStep == 0 && settings != null) {
                    if (fields.Count != 23 || Find<TextBox>("Persona").Text != "测试小鲸人设") { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "FAIL: configuration rendering"); exiting = true; Send("quit"); return; }
                    window.Close();
                    if (window.IsVisible) throw new Exception("Close did not hide window");
                    Process.Start(new ProcessStartInfo(Path.Combine(root, "QQ-BOT.exe")) { UseShellExecute = false, CreateNoWindow = true });
                    smokeStep = 1;
                } else if (smokeStep == 1 && window.IsVisible) {
                    File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "PASS: native config rendering, close to tray, duplicate instance restore, graceful exit");
                    smokeStep = 2; Exit();
                }
            }
        };
        timer.Start(); Send("load"); new Application().Run(window); timer.Stop();
    }
}
