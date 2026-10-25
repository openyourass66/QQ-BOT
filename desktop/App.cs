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

partial class App
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
    public class Choice { public string Value { get; set; } public string Label { get; set; } }
    public partial class SocialRow { public string Id { get; set; } public string Chat { get; set; } public string Name { get; set; } public string Summary { get; set; } public string Status { get; set; } public string Time { get; set; } public string Detail { get; set; } public string Text { get; set; } }
    static string[] socialSections = { "contacts", "messages", "memories", "stickers", "tasks", "events", "actions", "turns", "capabilities", "thoughts", "interests", "decisions" };
    static Dictionary<string, Dictionary<string, object>> socialProfiles = new Dictionary<string, Dictionary<string, object>>();
    static Window profileDialog;
    static SocialRow socialSelection;
    static Dictionary<string, string[]> choices = new Dictionary<string, string[]> {
        { "social.autonomy", new[] { "autonomous|自主执行", "sensitive|敏感动作需确认", "confirm|所有动作需确认" } },
        { "social.responseMode", new[] { "legacy|沿用群聊开关", "mention|仅直接对话", "keywords|直接对话和关键词", "probability|关键词和概率参与", "all|参与全部消息" } }
    };
    static Dictionary<string, string> labels = new Dictionary<string, string> {
        {"identity", "身份"}, {"name", "机器人名称"}, {"chat", "对话"}, {"privateAutoReply", "自动回复私聊"}, {"group", "群聊"}, {"requireMention", "需要 @ 或前缀"}, {"prefix", "触发前缀"}, {"cooldownMs", "旁聊冷却（毫秒）"}, {"contextLines", "群聊摘要行数"}, {"followUpMs", "追问窗口（毫秒）"}, {"proactive", "主动发言"}, {"enabled", "启用"}, {"perGroupPerDay", "每群每日额度"}, {"delay", "回复节奏"}, {"minMs", "最短延迟（毫秒）"}, {"maxMs", "最长延迟（毫秒）"}, {"chunkSize", "分片字符数"}, {"approval", "审批"}, {"adminQq", "管理员 QQ"}, {"allowExec", "自动允许执行命令"}, {"timeoutMs", "审批超时（毫秒）"}, {"features", "功能"}, {"qzone", "QQ 空间"}, {"dailyLimit", "每日额度"}, {"requireConfirm", "发布前确认"}, {"browsing", "浏览器（暂未接入）"}, {"maxNavigations", "最大导航次数"}, {"maxScreenshots", "最大截图次数"}, {"budgets", "每日额度"}, {"proactiveMessagesPerDay", "主动消息数"}, {"likesPerDay", "点赞次数"}
    };
    static T Find<T>(string name) where T : class { return window.FindName(name) as T; }
    static string Label(string key) { return labels.ContainsKey(key) ? labels[key] : key; }
    static void SocialRequest(string op = "list", bool blocked = true) {
        if (socialBusy) return;
        var row = Find<ListView>("SocialList").SelectedItem as SocialRow;
        if (op != "list" && op != "refresh_contacts" && row == null) { Feedback("请先选择一条记录。"); return; }
        if (dirtySections.Contains("memory") && op != "edit_memory"&&op!="edit_interest" && MessageBox.Show(window,"记录编辑尚未保存，继续会放弃编辑。", "记录编辑", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
        string deletePrompt=Find<ComboBox>("SocialSection").SelectedIndex==9?"取消这条自主想法？已发出的操作无法撤回。":Find<ComboBox>("SocialSection").SelectedIndex==10?"删除这条兴趣记录？":Find<ComboBox>("SocialSection").SelectedIndex==3?(row!=null&&row.Status.StartsWith("QQ收藏")?"从 QQ 账号的收藏表情中移除这张？本地理解缓存会保留。":"删除所选本地待同步记录？"):"删除这条记忆，或取消所选提醒？";
        if ((op == "delete" || op == "reset_session") && MessageBox.Show(window, op == "delete" ? deletePrompt : "清除该会话的 Agent 上下文？消息存档仍会保留。", "确认操作", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
        Find<TextBlock>("SocialNote").Text = "正在读取，请稍候…";
        SetSocialBusy(true);
        var data=new Dictionary<string,object> {{"op",op},{"section",socialSections[Math.Max(0,Find<ComboBox>("SocialSection").SelectedIndex)]},{"query",Find<TextBox>("SocialSearch").Text},{"id",row==null?"":row.Id},{"chat",op=="list"||op=="refresh_contacts"?"":row.Chat},{"text",op=="edit_memory"||op=="edit_interest"?Find<TextBox>("SocialDetail").Text:""},{"blocked",blocked}};
        if(row!=null&&(Find<ComboBox>("SocialSection").SelectedIndex==2||Find<ComboBox>("SocialSection").SelectedIndex==10)&&(op=="edit_memory"||op=="edit_interest"||op=="delete"))data["expectedText"]=row.Text;
        Send("social",data);
    }
    static void EditProfile() {
        var selected = Find<ListView>("SocialList").SelectedItem as SocialRow;
        if (selected == null || selected.Chat.Length == 0) { Feedback("请先在联系人或聊天记录中选一个会话。"); return; }
        Dictionary<string, object> old;
        socialProfiles.TryGetValue(selected.Chat, out old);
        var dialog = new Window { Title = selected.Name + " · 会话设置", Owner = window, Width = 600, MinWidth = 540, Height = Math.Min(700,SystemParameters.WorkArea.Height-24), MinHeight = 500, WindowStartupLocation = WindowStartupLocation.CenterOwner, Resources = window.Resources, Background = window.Background, FontFamily=window.FontFamily, FontSize=13, Foreground=window.Foreground };
        var panel = new StackPanel { Margin = new Thickness(24) }; dialog.Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }; profileDialog = dialog;
        panel.Children.Add(new TextBlock { Text = "仅对这个会话生效", FontSize = 18, FontWeight = FontWeights.Bold, Margin = new Thickness(0,0,0,14) });
        panel.Children.Add(new TextBlock { Text = "参与方式" });
        var mode = new ComboBox { DisplayMemberPath = "Label", SelectedValuePath = "Value", ItemsSource = new[] { "inherit|沿用全局", "mention|仅直接对话", "keywords|关键词", "probability|概率参与", "all|全部消息" }.Select(item => new Choice { Value = item.Split('|')[0], Label = item.Split('|')[1] }).ToList(), SelectedValue = old == null ? "inherit" : old["responseMode"], Margin = new Thickness(0,6,0,10) }; panel.Children.Add(mode);
        panel.Children.Add(new TextBlock { Text = "参与概率（0–100）" });
        var probability = new TextBox { Text = old == null ? "10" : old["probability"].ToString(), Margin = new Thickness(0,6,0,10) }; panel.Children.Add(probability);
        panel.Children.Add(new TextBlock { Text = "关键词（逗号分隔）" });
        var keywords = new TextBox { Text = old == null ? "" : string.Join(",", ((System.Collections.IEnumerable)old["keywords"]).Cast<object>()), Margin = new Thickness(0,6,0,10) }; panel.Children.Add(keywords);
        var effective=new TextBlock {FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,12)};panel.Children.Add(effective);
        Action refreshParticipation=()=>{
            string value=Convert.ToString(mode.SelectedValue);bool group=selected.Chat.StartsWith("group:");mode.IsEnabled=group;
            probability.IsEnabled=group&&value=="probability";keywords.IsEnabled=group&&(value=="keywords"||value=="probability");
            if(!group){effective.Text="当前为私聊，自动回复由全局“自动回复私聊”控制；下方的人设和主动聊天机会可独立设置。";return;}
            var global=(Dictionary<string,object>)settings["social"];string actual=value=="inherit"?Convert.ToString(global["responseMode"]):value;
            effective.Text="配置来源："+(value=="inherit"?"全局设置":"当前会话专属设置")+" · 参与方式："+(actual=="legacy"?"沿用全局群聊开关":actual=="mention"?"仅直接对话":actual=="keywords"?"直接对话和关键词":actual=="probability"?"关键词和概率参与":"参与全部消息")+(actual=="probability"?" · 概率 "+(value=="inherit"?global["responseProbability"].ToString():probability.Text)+"%":"")+"。直接对话包括 @、称呼、前缀、引用和有效追问；活跃话题可继续跟进。";
        };
        mode.SelectionChanged+=(s,e)=>refreshParticipation();probability.TextChanged+=(s,e)=>refreshParticipation();refreshParticipation();
        var proactive = new CheckBox { Content = "允许此会话参与主动聊天机会（仍受全局开关与额度约束）", IsChecked = old == null || (bool)old["proactive"], Margin = new Thickness(0,0,0,12) }; panel.Children.Add(proactive);
        panel.Children.Add(new TextBlock { Text = "会话专属人设（留空沿用工作区人设）" });
        var persona = new TextBox { Text = old == null ? "" : (string)old["persona"], AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 150, MaxLength=10000, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(0,6,0,14) }; AddPersonaPicker(panel,persona,persona.Text);panel.Children.Add(persona);
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Firebrick }; panel.Children.Add(error);
        var save = new Button { Content = "保存会话设置", HorizontalAlignment = HorizontalAlignment.Right }; panel.Children.Add(save);
        save.Click += (s,e) => { int value; if (!int.TryParse(probability.Text,out value) || value < 0 || value > 100 || persona.Text.Length > 10000) { error.Text = "概率应在 0–100 之间，人设最多 10000 字。"; return; }
            Send("social", new { op = "profile", section = "contacts", chat = selected.Chat, text = persona.Text, responseMode = mode.SelectedValue, probability = value, keywords = keywords.Text, proactive = proactive.IsChecked == true }); dialog.IsEnabled = false; };
        dialog.ShowDialog(); profileDialog = null;
    }
    static void Feedback(string text) { Find<TextBlock>("Feedback").Text = text; Find<TextBlock>("Feedback").ToolTip = text; }
    static void Send(string action, object data = null) {
        if (new[] { "settings", "env", "runtime", "connection", "persona" }.Contains(action)) Find<TabControl>("Tabs").IsEnabled = false;
        try { if (host == null || host.HasExited) throw new Exception(); hostInput.WriteLine(json.Serialize(new { action = action, data = data })); hostInput.Flush(); }
        catch { Find<TabControl>("Tabs").IsEnabled = true; SetSocialBusy(false); SetKnowledgeBusy(false);SetChatModelBusy(false); Feedback("控制进程不可用，请退出后重新打开控制台。"); }
    }
    static void Restore() { window.ShowInTaskbar = true; window.Show(); window.WindowState = WindowState.Normal; window.Activate(); window.Topmost = true; window.Topmost = false; }
    static void MarkDirty(string section) { if (!loading) { dirtySections.Add(section); dirty = true; Find<TextBlock>("SaveState").Text = "有尚未保存的修改"; UpdateConnectionEditing(); } }
    static void EditChanged(object sender, TextChangedEventArgs e) { MarkDirty(sender == Find<TextBox>("Env") ? "env" : sender == Find<TextBox>("Persona") ? "persona" : "settings"); }
    static void MakeFields(Dictionary<string, object> data, string prefix, StackPanel panel) { BuildSettings(data, panel); }
    static void RuntimeFields(object value) { BuildRuntimeFields(value); }
    static void RefreshLogs() {
        var search = Find<TextBox>("LogSearch").Text;
        int filter = Find<ComboBox>("LogFilter").SelectedIndex;
        var lines = logs.Where(line => (search.Length == 0 || line.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0) && (filter == 0 || filter == 1 && (line.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0 || line.Contains("失败") || line.Contains("EPERM")) || filter == 2 && line.Contains("[bridge]") || filter == 3 && line.Contains("[napcat]")));
        var text = string.Join(Environment.NewLine, lines);
        Find<StackPanel>("LogEmpty").Visibility = text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        ((TextBlock)Find<StackPanel>("LogEmpty").Children[0]).Text = logs.Count == 0 ? "还没有工作日志" : "没有匹配的日志";
        ((TextBlock)Find<StackPanel>("LogEmpty").Children[1]).Text = logs.Count == 0 ? "启动机器人后，连接与运行记录会出现在这里。" : "试试其他关键词或日志分类。";
        Find<TextBlock>("LogCount").Text = "显示 " + lines.Count() + " / " + logs.Count + " 条 · 最近 1500 条";
        if (Find<TextBox>("Logs").Text != text) { var editor=Find<TextBox>("Logs");double offset=editor.VerticalOffset;editor.Text=text;if(paused)editor.ScrollToVerticalOffset(offset);else editor.ScrollToEnd(); }
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
            else if (fields[path] is ComboBox) result[pair.Key] = ((ComboBox)fields[path]).SelectedValue;
            else if (pair.Value is string) result[pair.Key] = ((TextBox)fields[path]).Text;
            else if (pair.Value is System.Collections.IEnumerable) result[pair.Key] = ((TextBox)fields[path]).Text.Split(new[] { ',', '，', ';', '；', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(item => item.Trim()).Where(item => item.Length > 0).ToArray();
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
        if(type=="error"&&message.ContainsKey("action")&&(string)message["action"]=="model")ChatModelError((string)message["text"]);
        if(type=="model"){RenderChatModel(message);return;}
        if(type=="settings-status"){RenderSettingsStatus(message);Feedback("设置状态与今日额度已刷新。");return;}
        if(type=="error"&&message.ContainsKey("action")&&(string)message["action"]=="settings-status"){settingsStatusBusy=false;Find<Button>("SettingsRefresh").Content="刷新额度";}
        if (type == "error" && profileDialog != null) { profileDialog.IsEnabled = true; MessageBox.Show(profileDialog, (string)message["text"], "会话设置未保存"); }
        if (type == "log") {
            logs.Enqueue((string)message["text"]); while (logs.Count > 1500) logs.Dequeue();
        } else if (type == "error") { Find<TabControl>("Tabs").IsEnabled = true; SetSocialBusy(false); string text = (string)message["text"];if(message.ContainsKey("action")&&new[]{"knowledge","memory"}.Contains(message["action"] as string)){SetKnowledgeBusy(false);KnowledgeError(text);} Feedback(text); Find<TextBlock>("LastError").Text = text; Find<Border>("ErrorBanner").Visibility = Visibility.Visible; logs.Enqueue("[error] " + text); }
        else if (type == "saved") {
            Find<TabControl>("Tabs").IsEnabled = true;
            string section = (string)message["section"];
            if (section == "env" || section == "runtime" || section == "connection") {
                var result = (Dictionary<string,object>)message["result"]; loading = true; Find<TextBox>("Env").Text = (string)result["env"]; RuntimeFields(result["runtimeFields"]); loading = false;
                dirtySections.Remove("env"); dirtySections.Remove("runtime");
                if(result.ContainsKey("settingsPath")) {if(settingsPath!=(string)result["settingsPath"])Find<TextBlock>("SettingsQuota").Text="已切换动态配置文件，请重新启动机器人并刷新额度。";settingsPath=(string)result["settingsPath"];}
                if(result.ContainsKey("settings"))ApplySavedSettings((Dictionary<string,object>)result["settings"],section=="connection"?mediaKeys.Select(key=>"social."+key):new string[0]);
                connectionRestartPending=message.ContainsKey("restartRequested")&&(bool)message["restartRequested"];
                Find<TextBlock>("RuntimeHint").Text=message.ContainsKey("restartRequested")&&(bool)message["restartRequested"]?"配置已保存，正在重新启动机器人…":"配置已保存；连接参数重启后生效。";
            }
            if(section=="settings")ApplySavedSettings((Dictionary<string,object>)message["result"],savedSettingValues.Keys.ToArray());
            dirtySections.Remove(section); dirty = dirtySections.Count > 0;
            UpdateConnectionEditing();
            ReconcileDirtySettings();Feedback(message.ContainsKey("restartRequested")&&(bool)message["restartRequested"]?"配置已保存，正在重新启动机器人。":"保存成功。动态选项已保存；连接及媒体服务参数修改后需重启。");
        }
        else if (type == "social") { RenderActivity(message); }
        else if (type == "knowledge") { RenderKnowledge(message); }
        else if (type == "memory") { RenderKnowledgeMemories(message); }
        else if (type == "control" && connectionRestartPending && new[]{"restart","restartBridge"}.Contains(message["action"] as string)) {
            Find<TextBlock>("RuntimeHint").Text=(bool)message["ok"]?"机器人已重新启动，等待连接就绪。":"配置已保存，重新启动未完成，请查看启动诊断。";connectionRestartPending=false;
        }
        else if (type == "config") {
            loading = true;
            settings = (Dictionary<string, object>)message["settings"];
            if(message.ContainsKey("settingsPath"))settingsPath=(string)message["settingsPath"];
            var panel = Find<StackPanel>("Fields"); panel.Children.Clear(); fields.Clear(); MakeFields(settings, "", panel);
            RuntimeFields(message["runtimeFields"]);
            Find<TextBox>("Env").Text = (string)message["env"];
            Find<TextBox>("Persona").Text = (string)message["persona"];
            personaPath = (string)message["personaPath"];
            if(message.ContainsKey("knowledge"))RenderKnowledge((Dictionary<string,object>)message["knowledge"]);
            else RenderKnowledge(new Dictionary<string,object> {{"workspace",Path.GetDirectoryName(personaPath)},{"global",message["persona"]},{"globalRevision",null},{"libraryRevision",null},{"presets",new object[0]},{"files",new object[0]}});
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
            runtimeBusy=busy;
            Find<Button>("Start").IsEnabled = !busy && !(bridge && napcat); Find<Button>("Stop").IsEnabled = !busy && (bridge || napcat); Find<Button>("Restart").IsEnabled = !busy; Find<Button>("RestartBot").IsEnabled = !busy && (bridge || napcat); Find<Button>("RestartBot").Content=busy?"正在处理…":"重新启动";UpdateConnectionEditing();
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
            Find<TextBlock>("ModelState").Text = (bool)message["acpConnected"] ? (message.ContainsKey("model")?(string)message["model"]+" · 已就绪":"已就绪") : "连接中";
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
        DateTime smokeDeadline = DateTime.UtcNow.AddSeconds(25);
        var application = new Application();
        application.Resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Parse(File.ReadAllText(Path.Combine(root,"desktop/theme.xaml"),Encoding.UTF8)));
        window = (Window)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/window.xaml"), Encoding.UTF8));
        InitSettingsView(); InitRuntimeView(); InitActivityView(); InitKnowledgeView();
        window.Width = Math.Min(window.Width, SystemParameters.WorkArea.Width - 24);
        window.Height = Math.Min(window.Height, SystemParameters.WorkArea.Height - 24);
        var iconStream = typeof(App).Assembly.GetManifestResourceStream("whale.ico");
        trayImage = new System.Drawing.Icon(iconStream); iconStream.Position = 0; window.Icon = System.Windows.Media.Imaging.BitmapFrame.Create(iconStream);
        var mascot = (ImageSource)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/assets/whale.xaml"), Encoding.UTF8));
        Find<Image>("BrandIcon").Source = mascot;
        Find<Image>("HeroIcon").Source = (ImageSource)XamlReader.Parse(File.ReadAllText(Path.Combine(root, "desktop/assets/mascot.xaml"), Encoding.UTF8));
        string[] names = { "工作总览", "工作日志", "机器人设置", "连接与运行", "人设与记忆", "启动诊断", "QQ 活动" };
        string[] icons = { "M2,2 H18 V18 H2 Z M2,8 H18 M8,8 V18", "M3,3 H17 M3,9 H17 M3,15 H12", "M3,5 H17 M3,15 H17 M7,2 V8 M13,12 V18", "M7,5 H3 V15 H7 M13,5 H17 V15 H13 M6,10 H14", "M10,17 C-6,8 3,-2 10,5 C17,-2 26,8 10,17", "M10,2 A8,8 0 1 0 10,18 A8,8 0 1 0 10,2 M10,6 V11 M10,14 V15", "M2,3 H18 V14 H10 L5,18 V14 H2 Z" };
        for (int i=0; i<names.Length; i++) {
            var header = new StackPanel { Orientation = Orientation.Horizontal };
            header.Children.Add(new System.Windows.Shapes.Path { Data = Geometry.Parse(icons[i]), Stroke = (Brush)new BrushConverter().ConvertFromString("#667AA7"), StrokeThickness = 1.6, Width = 18, Height = 18, Stretch = Stretch.Uniform, Margin = new Thickness(0,0,13,0) });
            header.Children.Add(new TextBlock { Text = names[i] }); ((TabItem)Find<TabControl>("Tabs").Items[i]).Header = header;
        }
        string[] subtitles = { "连接、消息与运行状态，一目了然。", "查看连接与运行记录，定位问题。", "管理对话、回复节奏、审批与额度。", "管理 QQ、模型和运行参数。", "保存多套人设，管理群友与工作区记忆。", "检查启动依赖、连接路径与访问权限。", "查看联系人、聊天、记忆、提醒与动作结果。" };
        Find<TabControl>("Tabs").SelectionChanged += (s,e) => {
            if (e.Source != Find<TabControl>("Tabs")) return;
            int page = Find<TabControl>("Tabs").SelectedIndex;
            if (page >= 0 && page < names.Length) { Find<TextBlock>("PageTitle").Text = names[page]; Find<TextBlock>("PageSubtitle").Text = subtitles[page]; }
        };
        Find<Button>("Minimize").Click += (s,e) => window.WindowState = WindowState.Minimized;
        Find<Button>("Maximize").Click += (s,e) => window.WindowState = window.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        window.StateChanged += (s,e) => {
            bool maximized = window.WindowState == WindowState.Maximized;
            Find<System.Windows.Shapes.Path>("MaximizeGlyph").Data = Geometry.Parse(maximized ? "M3.5,1.5 H10.5 V8.5 H8.5 M1.5,3.5 H8.5 V10.5 H1.5 Z" : "M1.5,1.5 H10.5 V10.5 H1.5 Z");
            Find<Button>("Maximize").ToolTip = maximized ? "还原" : "最大化";
        };
        Find<Button>("CloseWindow").Click += (s,e) => window.Close();
        if (args.Length > 0 && args[0] == "--preview") {
            if (args.Length > 4) { window.Width = int.Parse(args[3]); window.Height = int.Parse(args[4]); }
            if (args.Length > 5) {
                var preview = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[5],Encoding.UTF8));
                Event(json.Serialize(preview["config"]));
                if (preview.ContainsKey("social")) Event(json.Serialize(preview["social"]));
                if (args.Length > 6) Find<ListBox>("SettingsNav").SelectedIndex = int.Parse(args[6]);
            }
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
        tray = new NativeTray(window, trayImage.Handle, args.Contains("--tray-check") ? "Whale UI tray check " + Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar)) : "小鲸工作台 · 点击打开");
        var menu = new ContextMenu();
        foreach (var entry in new[] { new[] { "打开小鲸工作台", "show" }, new[] { "启动机器人", "start" }, new[] { "重新启动机器人", "restart" }, new[] { "重连模型", "restartBridge" }, new[] { "停止机器人", "stop" }, new[] { "退出并停止机器人", "quit" } }) {
            var item = new MenuItem { Header = entry[0], Padding = new Thickness(14,8,14,8) }; string command = entry[1]; item.Click += (s,e) => { if (command == "show") Restore(); else if (command == "quit") Exit(); else Send(command); }; menu.Items.Add(item);
            System.Windows.Automation.AutomationProperties.SetAutomationId(item, "Tray-" + command);
        }
        tray.Click += Restore; tray.ContextMenu += () => { menu.Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint; menu.IsOpen = true; };
        window.Closing += (s, e) => { if (!exiting) { e.Cancel = true; if (tray.Ensure()) window.Hide(); else { window.WindowState = WindowState.Minimized; Feedback("托盘暂不可用，已保留任务栏窗口，可再次打开 EXE 恢复。"); } } };
        Find<Button>("Start").Click += (s, e) => Send("start"); Find<Button>("Stop").Click += (s, e) => Send("stop"); Find<Button>("Restart").Click += (s, e) => Send("restartBridge"); Find<Button>("RestartBot").Click += (s, e) => Send("restart");
        Find<Button>("Pause").Click += (s, e) => { paused = !paused; Find<Button>("Pause").Content = paused ? "继续滚动" : "暂停滚动"; };
        Find<Button>("Clear").Click += (s, e) => { logs.Clear(); Find<TextBox>("Logs").Clear(); };
        Find<Button>("SaveSettings").IsEnabled = false;
        labels["social"] = "QQ 自主行为";
        string[] socialKeys = { "autonomy", "allowAll", "allowedGroups", "allowedUsers", "blockedGroups", "blockedUsers", "responseMode", "keywords", "responseProbability", "batchWindowMs", "activeMinutes", "messagesPerMinute", "actionsPerDay", "memoryEnabled", "stickersEnabled", "mediaEnabled", "requestsEnabled", "filesEnabled", "remindersEnabled", "proactiveEnabled", "proactiveIntervalMinutes", "quietStartHour", "quietEndHour", "retentionDays", "messagesPerChat", "visionModel", "transcriptionModel", "speechModel", "speechVoice", "videoFrames" };
        string[] socialLabels = { "QQ 动作执行方式", "允许全部现有好友和群", "允许的群号", "允许的好友 QQ", "屏蔽群号", "屏蔽用户 QQ", "群聊参与方式", "参与关键词", "旁聊参与概率（百分比）", "消息聚合窗口（毫秒）", "话题活跃时间（分钟）", "每会话每分钟动作上限", "每日 QQ 动作上限", "群友长期记忆", "QQ 收藏表情", "图片、语音与视频", "好友与群申请处理", "文件收发", "定时提醒", "定时主动聊天机会", "主动机会间隔（分钟）", "安静时段开始（上海时间）", "安静时段结束（上海时间）", "消息保留天数", "每会话消息条数上限", "独立视觉模型（留空使用 DSH）", "语音转写模型（可选）", "语音合成模型（可选）", "合成声音", "视频抽帧数" };
        for (int i=0; i<socialKeys.Length; i++) labels[socialKeys[i]] = socialLabels[i];
        Find<Button>("SaveSettings").Click += (s, e) => { try { if (ValidateSettingsForm()) Send("settings", new {draft=Collect(settings,""),baseline=settings,paths=dirtySettingPaths.ToArray(),settingsPath=settingsPath}); } catch (Exception error) { Feedback(error.Message); } };
        Find<Button>("SettingsRefresh").Click += (s,e) => {settingsStatusBusy=true;Find<Button>("SettingsRefresh").IsEnabled=false;Find<Button>("SettingsRefresh").Content="读取中…";Send("settings-status");};
        Find<Button>("SaveEnv").Click += (s, e) => { if (dirtySections.Contains("runtime")) {Feedback("请先保存连接表单中的修改，再保存高级文本。");return;} Send("env",new {text=Find<TextBox>("Env").Text,settingsPath=settingsPath,hasSettingsDrafts=dirtySettingPaths.Count>0}); };
        Find<Button>("SaveRuntime").Click += (s,e) => SaveConnection(false);
        Find<Button>("SaveRuntimeRestart").Click += (s,e) => SaveConnection(true);
        Find<Button>("Memory").Click += (s, e) => { try { string path = Path.Combine(Path.GetDirectoryName(personaPath), "memory"); Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { Feedback("无法打开记忆目录，请先加载配置。"); } };
        Find<TextBox>("Env").TextChanged += EditChanged;
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
                    try { VerifySettingsInteraction(); VerifyRuntimeInteraction(); VerifyKnowledgeInteraction(); } catch(Exception error) { Environment.ExitCode=1;File.WriteAllText(Path.Combine(root,"smoke-result.txt"),"FAIL: "+error.Message);exiting=true;Send("quit");return; }
                    if (fields.Count < 53 || runtimeInputs.Count < 20 || Find<TextBox>("Persona").Text != "测试小鲸人设" || !tray.Registered) { Environment.ExitCode = 1; File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "FAIL: config=" + fields.Count + ", runtime=" + runtimeInputs.Count + ", tray=" + tray.Registered + ", personaLength=" + Find<TextBox>("Persona").Text.Length); exiting = true; Send("quit"); return; }
                    foreach (int page in new[] {0,1,2,3,4,5,6}) Capture(Path.Combine(root,"page-" + page + ".png"), page);
                    Send("settings", Collect(settings, ""));
                    SaveConnection(false);
                    NewKnowledge();Find<TextBox>("KnowledgeName").Text="Native saved preset";Find<TextBox>("Persona").Text="A saved persona from native controls.";SaveKnowledge();
                    Find<TabControl>("Tabs").SelectedIndex = 6;
                    Find<ComboBox>("SocialSection").SelectedIndex = 8;
                    smokeStep = 10;
                } else if (smokeStep == 10 && Find<ListView>("SocialList").Items.Count > 40 && Find<TabControl>("Tabs").IsEnabled) {
                    if(!knowledgeItems.Values.Any(row=>row.Kind=="preset"&&row.Name=="Native saved preset")||knowledgeDrafts.Count!=0){Environment.ExitCode=1;File.WriteAllText(Path.Combine(root,"smoke-result.txt"),"FAIL: native persona save");exiting=true;Send("quit");return;}
                    Capture(Path.Combine(root,"page-6-loaded.png"), 6);
                    if(Find<TextBlock>("SocialDetailTitle").Text=="尚未选择记录"||Find<TextBox>("SocialDetail").Text.Length==0){Environment.ExitCode=1;File.WriteAllText(Path.Combine(root,"smoke-result.txt"),"FAIL: activity detail selection");exiting=true;Send("quit");return;}
                    var dropdown=Find<ComboBox>("SocialSection");dropdown.Focus();dropdown.IsDropDownOpen=true;window.UpdateLayout();
                    smokeStep=11;
                } else if(smokeStep==11) {
                    var combo=Find<ComboBox>("SocialSection");var popup=(System.Windows.Controls.Primitives.Popup)combo.Template.FindName("PART_Popup",combo);
                    var element=popup.Child as FrameworkElement;
                    if(element==null||element.ActualWidth+1<combo.ActualWidth||!popup.IsOpen){Environment.ExitCode=1;File.WriteAllText(Path.Combine(root,"smoke-result.txt"),"FAIL: custom dropdown layout (popup="+popup.IsOpen+", width="+(element==null?0:element.ActualWidth)+", control="+combo.ActualWidth+")");exiting=true;Send("quit");return;}
                    var bitmap=new System.Windows.Media.Imaging.RenderTargetBitmap((int)Math.Ceiling(element.ActualWidth),(int)Math.Ceiling(element.ActualHeight),96,96,PixelFormats.Pbgra32);bitmap.Render(element);var encoder=new System.Windows.Media.Imaging.PngBitmapEncoder();encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));using(var output=File.Create(Path.Combine(root,"dropdown.png")))encoder.Save(output);
                    combo.IsDropDownOpen=false;Find<TextBox>("SocialSearch").Text="__no_match__";SocialRequest();smokeStep=12;
                } else if(smokeStep==12&&!socialBusy&&Find<ListView>("SocialList").Items.Count==0) {
                    if(Find<StackPanel>("SocialEmpty").Visibility!=Visibility.Visible||Find<StackPanel>("SocialActionPanel").Visibility!=Visibility.Collapsed){Environment.ExitCode=1;File.WriteAllText(Path.Combine(root,"smoke-result.txt"),"FAIL: activity empty state");exiting=true;Send("quit");return;}
                    Capture(Path.Combine(root,"page-6-empty.png"),6);
                    Find<ListBox>("KnowledgeNav").SelectedIndex=2;smokeStep=13;
                } else if(smokeStep==13&&!knowledgeBusy&&knowledgeSelection!=null&&knowledgeSelection.Kind=="file"&&knowledgeSelection.Loaded) {
                    Capture(Path.Combine(root,"knowledge-workspace.png"),4);Find<TextBox>("Persona").Text="Edited workspace memory from native controls.";SaveKnowledge();smokeStep=14;
                } else if(smokeStep==14&&!knowledgeBusy&&knowledgeDrafts.Count==0) {
                    if(File.ReadAllText(Path.Combine(root,"memory/notes.md"))!="Edited workspace memory from native controls.")throw new Exception("Workspace memory save failed");
                    Find<ListBox>("KnowledgeNav").SelectedIndex=1;smokeStep=15;
                } else if(smokeStep==15&&!knowledgeBusy&&knowledgeSelection!=null&&knowledgeSelection.Kind=="memory") {
                    Capture(Path.Combine(root,"knowledge-friends.png"),4);Find<TextBox>("Persona").Text="Edited friend memory from native controls.";SaveKnowledge();smokeStep=16;
                } else if(smokeStep==16&&!knowledgeBusy&&knowledgeDrafts.Count==0) {
                    if(knowledgeSelection.Text!="Edited friend memory from native controls."||Find<ListView>("SocialList").Items.Count!=0)throw new Exception("Friend memory save or activity isolation failed");
                    Find<TextBox>("SocialSearch").Clear();Find<TabControl>("Tabs").SelectedIndex=6;Find<ComboBox>("SocialSection").SelectedIndex=3;smokeStep=20;
                } else if(smokeStep==20&&!socialBusy&&Find<ListView>("SocialList").Items.Count==2) {
                    var list=Find<ListView>("SocialList");list.SelectedItem=list.Items.Cast<SocialRow>().First(row=>row.Id=="pending-sticker");
                    if(Find<Button>("SocialSave").Visibility!=Visibility.Visible||Convert.ToString(Find<Button>("SocialSave").Content)!="存入 QQ 收藏"||Convert.ToString(Find<Button>("SocialDelete").Content)!="删除本地记录"||!Find<TextBox>("SocialDetail").IsReadOnly)throw new Exception("Pending local sticker actions are incorrect");
                    Capture(Path.Combine(root,"qq-favorites-pending.png"),6);
                    list.SelectedItem=list.Items.Cast<SocialRow>().First(row=>row.Id=="qq-sticker");
                    if(Find<Button>("SocialSave").Visibility!=Visibility.Collapsed||Convert.ToString(Find<Button>("SocialDelete").Content)!="从 QQ 收藏移除"||Convert.ToString(Find<Button>("SocialRefresh").Content)!="刷新 QQ 收藏"||!Find<TextBlock>("SocialNote").Text.Contains("离线缓存"))throw new Exception("QQ favorite actions or offline state are incorrect");
                    Capture(Path.Combine(root,"qq-favorites-native.png"),6);smokeStep=21;
                } else if(smokeStep==21) {
                    Find<ComboBox>("SocialSection").SelectedIndex=9;smokeStep=22;
                } else if(smokeStep==22&&!socialBusy&&Find<ListView>("SocialList").Items.Count==1) {
                    if(Convert.ToString(Find<Button>("SocialSave").Content)!="推迟一小时"||Convert.ToString(Find<Button>("SocialDelete").Content)!="取消想法"||!Find<TextBox>("SocialDetail").IsReadOnly)throw new Exception("Autonomous thought controls are incorrect");
                    Capture(Path.Combine(root,"autonomy-thoughts.png"),6);Find<ComboBox>("SocialSection").SelectedIndex=10;smokeStep=23;
                } else if(smokeStep==23&&!socialBusy&&Find<ListView>("SocialList").Items.Count==1) {
                    if(Find<TextBox>("SocialDetail").IsReadOnly||Find<TextBox>("SocialDetail").Text!="Cat stickers")throw new Exception("Interest editor is unavailable");
                    Find<TextBox>("SocialDetail").Text="Edited interest from native controls.";SocialRequest("edit_interest");smokeStep=24;
                } else if(smokeStep==24&&!socialBusy&&socialSelection!=null&&socialSelection.Text=="Edited interest from native controls.") {
                    if(dirtySections.Contains("memory"))throw new Exception("Interest draft was not cleared after save");Capture(Path.Combine(root,"autonomy-interests.png"),6);Find<ComboBox>("SocialSection").SelectedIndex=11;smokeStep=25;
                } else if(smokeStep==25&&!socialBusy&&Find<ListView>("SocialList").Items.Count==1) {
                    if(!Find<TextBox>("SocialDetail").IsReadOnly||Find<StackPanel>("SocialActionPanel").Visibility!=Visibility.Collapsed||!Find<TextBox>("SocialDetail").Text.Contains("Nothing worth publishing"))throw new Exception("Autonomous decision summary is incorrect");Capture(Path.Combine(root,"autonomy-decisions.png"),6);smokeStep=26;
                } else if(smokeStep==26) {
                    dirtySections.Add("memory");Find<Button>("SettingsRefresh").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));smokeStep=27;
                } else if(smokeStep==27&&!settingsStatusBusy) {
                    if(!Find<TextBlock>("SettingsQuota").Text.Contains("今日额度")||!dirtySections.Contains("memory")||Find<ListView>("SocialList").Items.Count!=1)throw new Exception("Refreshing quotas changed activity or memory drafts");
                    dirtySections.Remove("memory");ReconcileDirtySettings();Find<ListBox>("SettingsNav").SelectedIndex=4;Capture(Path.Combine(root,"settings-quotas.png"),2);
                    Find<TabControl>("Tabs").SelectedIndex = 0;
                    window.Close();
                    if (window.IsVisible) throw new Exception("Close did not hide window");
                    Process.Start(new ProcessStartInfo(Path.Combine(root, "QQ-BOT.exe")) { UseShellExecute = false, CreateNoWindow = true });
                    smokeStep = 1;
                } else if (smokeStep == 1 && window.IsVisible) {
                    File.WriteAllText(Path.Combine(root, "smoke-result.txt"), "PASS: persona library save and selection, independent conversation copies, retained drafts, workspace and friend memory editing, compact layout, settings and model validation, activity isolation, QQ favorites and local migration controls, autonomous thought controls, interest editing, decision summaries, Shell tray restore, graceful exit");
                    smokeStep = 2; Exit();
                }
            }
        };
        timer.Start(); Send("load"); Send("diagnose"); application.Run(window); timer.Stop();
    }
}
