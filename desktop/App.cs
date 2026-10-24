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
using System.Windows.Interop;
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
    static Dictionary<string, Control> runtimeInputs = new Dictionary<string, Control>();
    static Dictionary<string, object> settings;
    static Queue<string> logs = new Queue<string>();
    static bool exiting, paused, dirty, loading, hostFailed;
    static HashSet<string> dirtySections = new HashSet<string>();
    static string personaPath;
    static NativeTray tray;
    static System.Drawing.Icon trayImage;
    static int ticks;
    static EventWaitHandle restore;
    static Dictionary<string, string> labels = new Dictionary<string, string> {
        {"identity", "身份"}, {"name", "机器人名称"}, {"chat", "对话"}, {"privateAutoReply", "自动回复私聊"}, {"group", "群聊"}, {"requireMention", "需要 @ 或前缀"}, {"prefix", "触发前缀"}, {"cooldownMs", "旁聊冷却（毫秒）"}, {"contextLines", "群聊摘要行数"}, {"followUpMs", "追问窗口（毫秒）"}, {"proactive", "主动发言"}, {"enabled", "启用"}, {"perGroupPerDay", "每群每日额度"}, {"delay", "回复节奏"}, {"minMs", "最短延迟（毫秒）"}, {"maxMs", "最长延迟（毫秒）"}, {"chunkSize", "分片字符数"}, {"approval", "审批"}, {"adminQq", "管理员 QQ"}, {"allowExec", "自动允许执行命令"}, {"timeoutMs", "审批超时（毫秒）"}, {"features", "功能"}, {"qzone", "QQ 空间"}, {"dailyLimit", "每日额度"}, {"requireConfirm", "发布前确认"}, {"browsing", "浏览器（暂未接入）"}, {"maxNavigations", "最大导航次数"}, {"maxScreenshots", "最大截图次数"}, {"budgets", "每日额度"}, {"proactiveMessagesPerDay", "主动消息数"}, {"likesPerDay", "点赞次数"}
    };
    static T Find<T>(string name) where T : class { return window.FindName(name) as T; }
    static string Label(string key) { return labels.ContainsKey(key) ? labels[key] : key; }
    static void Feedback(string text) { Find<TextBlock>("Feedback").Text = text; Find<TextBlock>("Feedback").ToolTip = text; }
    static void Send(string action, object data = null) {
        if (new[] { "settings", "env", "runtime", "persona" }.Contains(action)) Find<TabControl>("Tabs").IsEnabled = false;
        try { if (host == null || host.HasExited) throw new Exception(); hostInput.WriteLine(json.Serialize(new { action = action, data = data })); hostInput.Flush(); }
        catch { Find<TabControl>("Tabs").IsEnabled = true; Feedback("控制进程不可用，请退出后重新打开控制台。"); }
    }
    static void Restore() { window.ShowInTaskbar = true; window.Show(); window.WindowState = WindowState.Normal; window.Activate(); window.Topmost = true; window.Topmost = false; }
    static void MarkDirty(string section) { if (!loading) { dirtySections.Add(section); dirty = true; Find<TextBlock>("SaveState").Text = "有尚未保存的修改"; } }
    static void EditChanged(object sender, TextChangedEventArgs e) { MarkDirty(sender == Find<TextBox>("Env") ? "env" : sender == Find<TextBox>("Persona") ? "persona" : "settings"); }
    static void MakeFields(Dictionary<string, object> data, string prefix, StackPanel panel) {
        foreach (var pair in data) {
            string path = prefix + pair.Key;
            var nested = pair.Value as Dictionary<string, object>;
            if (nested != null) {
                var group = new StackPanel();
                group.Children.Add(new TextBlock { Text = Label(pair.Key), FontSize = 15, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 4, 0, 15) });
                MakeFields(nested, path + ".", group);
                if (prefix.Length == 0) panel.Children.Add(new Border { Child = group, Background = (Brush)new BrushConverter().ConvertFromString("#F7F9FD"), CornerRadius = new CornerRadius(14), Padding = new Thickness(18), Margin = new Thickness(0, 0, 8, 15) });
                else panel.Children.Add(group);
                continue;
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
    static void RuntimeFields(object value) {
        var panel = Find<StackPanel>("RuntimeFields"); panel.Children.Clear(); runtimeInputs.Clear();
        string lastGroup = "";
        foreach (Dictionary<string, object> field in (System.Collections.IEnumerable)value) {
            string key = (string)field["key"], group = (string)field["group"], kind = (string)field["kind"];
            if (group != lastGroup) { panel.Children.Add(new TextBlock { Text = group, FontSize = 15, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 18, 0, 12) }); lastGroup = group; }
            var row = new Grid { Margin = new Thickness(0, 0, 8, 12) }; row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(220) }); row.ColumnDefinitions.Add(new ColumnDefinition());
            row.Children.Add(new TextBlock { Text = (string)field["label"], VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 12, 0) });
            Control input;
            if (kind == "secret") { var password = new PasswordBox { Password = (string)field["value"] }; password.PasswordChanged += (s, e) => MarkDirty("runtime"); input = password; }
            else { var text = new TextBox { Text = (string)field["value"] }; text.TextChanged += (s, e) => MarkDirty("runtime"); input = text; }
            runtimeInputs[key] = input; System.Windows.Automation.AutomationProperties.SetName(input, (string)field["label"]);
            var holder = new DockPanel();
            if (kind == "file" || kind == "folder") {
                var browse = new Button { Content = "选择", Padding = new Thickness(9, 7, 9, 7), Margin = new Thickness(7, 0, 0, 0) };
                browse.Click += (s, e) => { if (kind == "folder") { using (var dialog = new Forms.FolderBrowserDialog()) { if (dialog.ShowDialog() == Forms.DialogResult.OK) ((TextBox)input).Text = dialog.SelectedPath; } } else { var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "所有文件|*.*" }; if (dialog.ShowDialog(window) == true) ((TextBox)input).Text = dialog.FileName; } };
                DockPanel.SetDock(browse, Dock.Right); holder.Children.Add(browse);
            }
            holder.Children.Add(input); Grid.SetColumn(holder, 1); row.Children.Add(holder); panel.Children.Add(row);
        }
    }
    static void RefreshLogs() {
        var search = Find<TextBox>("LogSearch").Text;
        int filter = Find<ComboBox>("LogFilter").SelectedIndex;
        var lines = logs.Where(line => (search.Length == 0 || line.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0) && (filter == 0 || filter == 1 && (line.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0 || line.Contains("失败") || line.Contains("EPERM")) || filter == 2 && line.Contains("[bridge]") || filter == 3 && line.Contains("[napcat]")));
        var text = string.Join(Environment.NewLine, lines);
        Find<StackPanel>("LogEmpty").Visibility = text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        ((TextBlock)Find<StackPanel>("LogEmpty").Children[0]).Text = logs.Count == 0 ? "还没有工作日志" : "没有匹配的日志";
        ((TextBlock)Find<StackPanel>("LogEmpty").Children[1]).Text = logs.Count == 0 ? "启动机器人后，连接与运行记录会出现在这里。" : "试试其他关键词或日志分类。";
        Find<TextBlock>("LogCount").Text = "显示 " + lines.Count() + " / " + logs.Count + " 条 · 最近 1500 条";
        if (Find<TextBox>("Logs").Text != text) { Find<TextBox>("Logs").Text = text; if (!paused) Find<TextBox>("Logs").ScrollToEnd(); }
    }
    static void Capture(string path, int page) {
        Find<TabControl>("Tabs").SelectedIndex = page; window.UpdateLayout();
        var content = (FrameworkElement)window.Content;
        var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap((int)content.ActualWidth, (int)content.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(content);
        var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder(); encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
        using (var output = File.Create(path)) encoder.Save(output);
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
        } else if (type == "error") { Find<TabControl>("Tabs").IsEnabled = true; string text = (string)message["text"]; Feedback(text); Find<TextBlock>("LastError").Text = text; Find<Border>("ErrorBanner").Visibility = Visibility.Visible; logs.Enqueue("[error] " + text); }
        else if (type == "saved") {
            Find<TabControl>("Tabs").IsEnabled = true;
            string section = (string)message["section"];
            if (section == "env" || section == "runtime") {
                var result = (Dictionary<string,object>)message["result"]; loading = true; Find<TextBox>("Env").Text = (string)result["env"]; RuntimeFields(result["runtimeFields"]); loading = false;
                dirtySections.Remove("env"); dirtySections.Remove("runtime");
            }
            dirtySections.Remove(section); dirty = dirtySections.Count > 0; Find<TextBlock>("SaveState").Text = dirty ? "还有尚未保存的修改" : "所有修改已保存"; Feedback("保存成功。动态设置即时生效；连接参数需重启，人设在新会话生效。");
        }
        else if (type == "config") {
            loading = true;
            settings = (Dictionary<string, object>)message["settings"];
            var panel = Find<StackPanel>("Fields"); panel.Children.Clear(); fields.Clear(); MakeFields(settings, "", panel);
            RuntimeFields(message["runtimeFields"]);
            Find<TextBox>("Env").Text = (string)message["env"];
            Find<TextBox>("Persona").Text = (string)message["persona"];
            personaPath = (string)message["personaPath"];
            Find<TextBlock>("PersonaHint").Text = "人设：" + personaPath + "\n保存后新会话生效；记忆可从目录中管理。";
            loading = false; dirty = false; Find<Button>("SaveSettings").IsEnabled = true;
            Feedback("配置已加载，小鲸准备好了。");
        } else if (type == "diagnostics") {
            var panel = Find<StackPanel>("Diagnostics"); panel.Children.Clear();
            foreach (Dictionary<string, object> row in (System.Collections.IEnumerable)message["rows"]) {
                bool ok = (bool)row["ok"];
                var block = new StackPanel(); block.Children.Add(new TextBlock { Text = (ok ? "通过  ·  " : "需处理  ·  ") + row["name"], FontWeight = FontWeights.Bold, Foreground = (Brush)new BrushConverter().ConvertFromString(ok ? "#26745A" : "#A02F44") });
                block.Children.Add(new TextBlock { Text = (string)row["detail"], TextWrapping = TextWrapping.Wrap, Foreground = Brushes.SlateGray, Margin = new Thickness(0, 7, 0, 0) });
                panel.Children.Add(new Border { Child = block, Background = (Brush)new BrushConverter().ConvertFromString(ok ? "#F0F8F4" : "#FFF0F1"), Padding = new Thickness(16), CornerRadius = new CornerRadius(12), Margin = new Thickness(0, 0, 8, 10) });
            }
            Find<TextBlock>("HealthSummary").Text = (bool)message["ok"] ? "启动依赖检查通过，小鲸已经准备好。" : "发现需要处理的项目，请到「启动诊断」查看详情。";
            Find<TextBlock>("DiagnosticSummary").Text = (bool)message["ok"] ? "启动检查通过" : "有项目需要处理";
        } else if (type == "state") {
            bool bridge = (bool)message["bridge"], napcat = (bool)message["napcat"], busy = (bool)message["busy"];
            Find<TextBlock>("State").Text = busy ? "小鲸正在安排工作…" : bridge && napcat ? "小鲸已出发，等待连接就绪" : bridge || napcat ? "部分进程运行中，请查看日志" : "小鲸休息中，随时可以出发";
            Find<Button>("Start").IsEnabled = !busy && !(bridge && napcat); Find<Button>("Stop").IsEnabled = !busy && (bridge || napcat); Find<Button>("Restart").IsEnabled = !busy;
            if (!bridge) Find<TextBlock>("Stats").Text = "桥接已停止 · NapCat " + (napcat ? "运行中" : "已停止");
            Find<TextBlock>("NapcatState").Text = napcat ? (message.ContainsKey("externalNapcat") && (bool)message["externalNapcat"] ? "复用外部 NapCat" : "NapCat 运行中") : "NapCat 等待启动";
            if (!bridge) { Find<TextBlock>("ModelState").Text = "未连接"; Find<TextBlock>("QqState").Text = napcat ? "等待桥接" : "未连接"; }
            if (!bridge) {
                Find<TextBlock>("ConnectionBadge").Text = busy ? "处理中" : "未启动"; Find<TextBlock>("Uptime").Text = "尚未启动";
                Find<TextBlock>("ConnectionBadge").Foreground = (Brush)new BrushConverter().ConvertFromString("#66748C");
                Find<System.Windows.Shapes.Ellipse>("ConnectionDot").Fill = (Brush)new BrushConverter().ConvertFromString("#98A5BC");
                Find<Border>("ConnectionPill").Background = (Brush)new BrushConverter().ConvertFromString("#EDF1F7");
            }
        } else if (type == "status") {
            bool online = (bool)message["qqOnline"] && (bool)message["wsConnected"] && (bool)message["acpConnected"];
            Find<TextBlock>("State").Text = online ? "小鲸在线，正在认真陪伴" : "进程运行中，等待 QQ / 模型连接";
            Find<TextBlock>("Stats").Text = "QQ " + ((bool)message["qqOnline"] ? "在线" : "离线") + "  ·  模型 " + ((bool)message["acpConnected"] ? "已连接" : "未连接") + "  ·  收到 " + message["messagesIn"] + " / 发出 " + message["messagesOut"] + "  ·  排队 " + message["pendingMessages"];
            Find<TextBlock>("QqState").Text = (bool)message["qqOnline"] ? "已在线" : "连接中";
            Find<TextBlock>("ModelState").Text = (bool)message["acpConnected"] ? "已就绪" : "连接中";
            Find<TextBlock>("MessagesIn").Text = message["messagesIn"].ToString();
            Find<TextBlock>("MessagesOut").Text = message["messagesOut"].ToString();
            Find<TextBlock>("Sessions").Text = message["sessions"].ToString();
            Find<TextBlock>("Pending").Text = message["pendingMessages"].ToString();
            Find<TextBlock>("QueueState").Text = Convert.ToInt32(message["pendingMessages"]) == 0 ? "队列空闲" : "正在处理与等待";
            if (online) Find<Border>("ErrorBanner").Visibility = Visibility.Collapsed;
            Find<TextBlock>("ConnectionBadge").Text = online ? "运行中" : "连接中";
            Find<TextBlock>("ConnectionBadge").Foreground = (Brush)new BrushConverter().ConvertFromString(online ? "#3A866F" : "#97733F");
            Find<System.Windows.Shapes.Ellipse>("ConnectionDot").Fill = Find<TextBlock>("ConnectionBadge").Foreground;
            Find<Border>("ConnectionPill").Background = (Brush)new BrushConverter().ConvertFromString(online ? "#EAF5F0" : "#FCF5E9");
            var elapsed = TimeSpan.FromMilliseconds(Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Convert.ToInt64(message["startedAt"])));
            Find<TextBlock>("Uptime").Text = "运行 " + (int)elapsed.TotalHours + elapsed.ToString(@"\:mm\:ss");
        }
    }
    [STAThread] static void Main(string[] args) {
        root = AppDomain.CurrentDomain.BaseDirectory;
        bool owner;
        string id = BitConverter.ToString(System.Security.Cryptography.SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
        if (args.Length > 0 && args[0] == "--preview") id += Guid.NewGuid().ToString("N");
        using (var mutex = new Mutex(true, "Local\\QQBotDesktop-" + id, out owner)) {
            restore = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\QQBotRestore-" + id);
            if (!owner) { restore.Set(); return; }
            try { Run(args); } catch (Exception e) { MessageBox.Show(e.Message, "小鲸控制台启动失败"); }
            finally { if (tray != null) tray.Dispose(); if (trayImage != null) trayImage.Dispose(); if (host != null) { try { hostInput.Close(); } catch {} } restore.Dispose(); mutex.ReleaseMutex(); }
        }
    }
    static void Run(string[] args) {
        bool smoke = args.Length > 0 && args[0] == "--smoke";
        int smokeStep = 0;
        DateTime smokeDeadline = DateTime.UtcNow.AddSeconds(20);
        window = (Window)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/window.xaml"), Encoding.UTF8));
        var iconStream = typeof(App).Assembly.GetManifestResourceStream("whale.ico");
        trayImage = new System.Drawing.Icon(iconStream); iconStream.Position = 0; window.Icon = System.Windows.Media.Imaging.BitmapFrame.Create(iconStream);
        var mascot = (ImageSource)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/assets/whale.xaml"), Encoding.UTF8));
        Find<Image>("BrandIcon").Source = mascot;
        Find<Image>("HeroIcon").Source = (ImageSource)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/assets/mascot.xaml"), Encoding.UTF8));
        string[] names = { "工作总览", "工作日志", "机器人设置", "连接与运行", "人设与记忆", "启动诊断" };
        string[] icons = { "M2,2 H18 V18 H2 Z M2,8 H18 M8,8 V18", "M3,3 H17 M3,9 H17 M3,15 H12", "M3,5 H17 M3,15 H17 M7,2 V8 M13,12 V18", "M7,5 H3 V15 H7 M13,5 H17 V15 H13 M6,10 H14", "M10,17 C-6,8 3,-2 10,5 C17,-2 26,8 10,17", "M10,2 A8,8 0 1 0 10,18 A8,8 0 1 0 10,2 M10,6 V11 M10,14 V15" };
        for (int i=0; i<names.Length; i++) {
            var header = new StackPanel { Orientation = Orientation.Horizontal };
            header.Children.Add(new System.Windows.Shapes.Path { Data = Geometry.Parse(icons[i]), Stroke = (Brush)new BrushConverter().ConvertFromString("#667AA7"), StrokeThickness = 1.6, Width = 18, Height = 18, Stretch = Stretch.Uniform, Margin = new Thickness(0,0,13,0) });
            header.Children.Add(new TextBlock { Text = names[i] }); ((TabItem)Find<TabControl>("Tabs").Items[i]).Header = header;
        }
        string[] subtitles = { "连接、消息与运行状态，一目了然。", "查看连接与运行记录，定位问题。", "管理对话、回复节奏、审批与额度。", "管理 QQ、模型和运行参数。", "编辑人设，管理工作区记忆。", "检查启动依赖、连接路径与访问权限。" };
        Find<TabControl>("Tabs").SelectionChanged += (s,e) => {
            if (e.Source != Find<TabControl>("Tabs")) return;
            int page = Find<TabControl>("Tabs").SelectedIndex;
            if (page >= 0 && page < names.Length) { Find<TextBlock>("PageTitle").Text = names[page]; Find<TextBlock>("PageSubtitle").Text = subtitles[page]; }
        };
        Find<Button>("Minimize").Click += (s,e) => window.WindowState = WindowState.Minimized;
        Find<Button>("Maximize").Click += (s,e) => window.WindowState = window.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        Find<Button>("CloseWindow").Click += (s,e) => window.Close();
        if (args.Length > 0 && args[0] == "--preview") {
            if (args.Length > 4) { window.Width = int.Parse(args[3]); window.Height = int.Parse(args[4]); }
            window.Show(); window.UpdateLayout();
            Capture(args[1], args.Length > 2 ? int.Parse(args[2]) : 0); window.Close(); return;
        }
        string node = Path.Combine(root, "runtime/node.exe");
        var info = new ProcessStartInfo(File.Exists(node) ? node : "node.exe", "\"" + Path.Combine(root, "desktop/host.mjs") + "\"") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        info.EnvironmentVariables["QQBOT_LOW_INTEGRITY"] = NativeTray.IsLowIntegrity() ? "1" : "0";
        host = new Process { StartInfo = info, EnableRaisingEvents = true };
        host.OutputDataReceived += (s, e) => { if (e.Data != null) events.Enqueue(e.Data); };
        host.ErrorDataReceived += (s, e) => { if (e.Data != null) events.Enqueue("{\"type\":\"error\",\"text\":\"控制进程异常，请检查配置与 Node 版本。\"}"); };
        host.Start(); hostInput = new StreamWriter(host.StandardInput.BaseStream, new UTF8Encoding(false)); host.BeginOutputReadLine(); host.BeginErrorReadLine();
        tray = new NativeTray(window, trayImage.Handle, args.Contains("--tray-check") ? "Whale UI tray check" : "小鲸工作台 · 点击打开");
        var menu = new ContextMenu();
        foreach (var entry in new[] { new[] { "打开小鲸工作台", "show" }, new[] { "启动机器人", "start" }, new[] { "重连模型", "restartBridge" }, new[] { "停止机器人", "stop" }, new[] { "退出并停止机器人", "quit" } }) {
            var item = new MenuItem { Header = entry[0], Padding = new Thickness(14,8,14,8) }; string command = entry[1]; item.Click += (s,e) => { if (command == "show") Restore(); else if (command == "quit") Exit(); else Send(command); }; menu.Items.Add(item);
        }
        tray.Click += Restore; tray.ContextMenu += () => { menu.Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint; menu.IsOpen = true; };
        window.Closing += (s, e) => { if (!exiting) { e.Cancel = true; if (tray.Ensure()) window.Hide(); else { window.WindowState = WindowState.Minimized; Feedback("托盘暂不可用，已保留任务栏窗口，可再次打开 EXE 恢复。"); } } };
        Find<Button>("ExitApp").Click += (s,e) => Exit();
        Find<Button>("Start").Click += (s, e) => Send("start"); Find<Button>("Stop").Click += (s, e) => Send("stop"); Find<Button>("Restart").Click += (s, e) => Send("restartBridge");
        Find<Button>("Pause").Click += (s, e) => { paused = !paused; Find<Button>("Pause").Content = paused ? "继续滚动" : "暂停滚动"; };
        Find<Button>("Clear").Click += (s, e) => { logs.Clear(); Find<TextBox>("Logs").Clear(); };
        Find<Button>("SaveSettings").IsEnabled = false;
        Find<Button>("SaveSettings").Click += (s, e) => { try { Send("settings", Collect(settings, "")); } catch (Exception error) { Feedback(error.Message); } };
        Find<Button>("SaveEnv").Click += (s, e) => { if (dirtySections.Contains("runtime") && MessageBox.Show(window,"保存高级文本将覆盖连接表单中尚未保存的编辑，继续吗？","保存连接配置",MessageBoxButton.YesNo) != MessageBoxResult.Yes) return; Send("env", Find<TextBox>("Env").Text); };
        Find<Button>("SaveRuntime").Click += (s,e) => { if (dirtySections.Contains("env") && MessageBox.Show(window,"保存表单将覆盖高级文本中尚未保存的编辑，继续吗？","保存连接配置",MessageBoxButton.YesNo) != MessageBoxResult.Yes) return; var data = runtimeInputs.ToDictionary(pair => pair.Key, pair => pair.Value is PasswordBox ? ((PasswordBox)pair.Value).Password : ((TextBox)pair.Value).Text); Send("runtime", data); };
        Find<Button>("SavePersona").Click += (s, e) => Send("persona", new { text = Find<TextBox>("Persona").Text, path = personaPath });
        Find<Button>("Memory").Click += (s, e) => { try { string path = Path.Combine(Path.GetDirectoryName(personaPath), "memory"); Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { Feedback("无法打开记忆目录，请先加载配置。"); } };
        Find<TextBox>("Env").TextChanged += EditChanged; Find<TextBox>("Persona").TextChanged += EditChanged;
        Find<TextBox>("LogSearch").TextChanged += (s,e) => RefreshLogs(); Find<ComboBox>("LogFilter").SelectionChanged += (s,e) => RefreshLogs();
        Find<Button>("Diagnose").Click += (s,e) => { Find<TabControl>("Tabs").SelectedIndex = 5; Send("diagnose"); }; Find<Button>("RunDiagnostics").Click += (s,e) => Send("diagnose");
        Find<Button>("OpenLogs").Click += (s,e) => { string path = Path.Combine(root,"data/desktop"); Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); };
        Find<Button>("ExportLogs").Click += (s,e) => { var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "小鲸运行日志.txt", Filter = "文本日志|*.txt" }; if (dialog.ShowDialog(window) == true) { try { File.WriteAllLines(dialog.FileName, logs, new UTF8Encoding(true)); Feedback("日志已导出，连接凭据已自动遮盖。"); } catch (Exception error) { Feedback(error.Message); } } };
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
        timer.Tick += (s, e) => {
            if (restore.WaitOne(0)) Restore();
            string line; int count = 0; while (count++ < 300 && events.TryDequeue(out line)) { try { Event(line); } catch { Feedback("收到无效的控制消息。"); } }
            RefreshLogs();
            if (++ticks % 25 == 0) tray.Ensure();
            if (host.HasExited) { if (exiting) { timer.Stop(); window.Close(); } else if (!hostFailed) { hostFailed = true; Find<TextBlock>("State").Text = "控制进程已退出"; Feedback("请退出并重新打开控制台。"); } }
            if (smoke && !exiting) {
                if (DateTime.UtcNow > smokeDeadline) { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "FAIL: lifecycle timeout"); exiting = true; Send("quit"); return; }
                if (smokeStep == 0 && settings != null) {
                    if (fields.Count != 23 || runtimeInputs.Count < 20 || Find<TextBox>("Persona").Text != "测试小鲸人设" || !tray.Registered) { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "FAIL: config=" + fields.Count + ", runtime=" + runtimeInputs.Count + ", tray=" + tray.Registered + ", personaLength=" + Find<TextBox>("Persona").Text.Length); exiting = true; Send("quit"); return; }
                    foreach (int page in new[] {0,1,2,3,4,5}) Capture(Path.Combine(root,"page-" + page + ".png"), page);
                    Find<TabControl>("Tabs").SelectedIndex = 0;
                    window.Close();
                    if (window.IsVisible) throw new Exception("Close did not hide window");
                    Process.Start(new ProcessStartInfo(Path.Combine(root, "QQ-BOT.exe")) { UseShellExecute = false, CreateNoWindow = true });
                    smokeStep = 1;
                } else if (smokeStep == 1 && window.IsVisible) {
                    File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "PASS: native config rendering, Shell tray registration, close to tray, duplicate instance restore, graceful exit");
                    smokeStep = 2; Exit();
                }
            }
        };
        timer.Start(); Send("load"); Send("diagnose"); new Application().Run(window); timer.Stop();
    }
}
