using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Forms = System.Windows.Forms;

partial class App
{
    class FieldSpec {
        public string Path, Category, Card, Title, Help, Unit;
        public long Min, Max, Step;
        public FieldSpec(string path, string category, string card, string title, string help, string unit = "", long min = 0, long max = 10000, long step = 1) { Path=path; Category=category; Card=card; Title=title; Help=help; Unit=unit; Min=min; Max=max; Step=step; }
    }
    public class SettingsCategory { public string Name { get; set; } public string Description { get; set; } public string Count { get; set; } }
    class FieldView { public FieldSpec Spec; public FrameworkElement Row, Editor; public TextBlock Error; }
    class SettingsCard { public string Category; public Border Surface; public List<FieldView> Rows = new List<FieldView>(); }
    static List<SettingsCard> settingsCards = new List<SettingsCard>();
    static Dictionary<string, FieldView> fieldViews = new Dictionary<string, FieldView>();
    static string selectedCategory = "对话与参与";
    static readonly string[] categoryNames = { "对话与参与", "联系与权限", "功能与媒体", "主动与提醒", "额度与节奏", "身份与审批", "存储与高级" };
    static readonly string[] categoryDescriptions = {
        "决定什么时候回应，以及如何自然地参与聊天。", "设置可联系的对象，以及 QQ 动作的执行方式。", "按需启用能力，并为图片、语音和视频选择模型。", "安排主动聊天机会、群聊主动发言和安静时段。", "控制每天的使用量，并调整消息发送的节奏。", "配置小鲸的名字、管理员和工作区操作审批。", "调整本地记录的保留范围与预留的高级选项。"
    };
    static readonly FieldSpec[] fieldSpecs = {
        new FieldSpec("chat.privateAutoReply", "对话与参与", "参与方式", "自动回复私聊", "收到好友私聊后，允许小鲸自然回应。"),
        new FieldSpec("social.responseMode", "对话与参与", "参与方式", "群聊参与方式", "直接找小鲸的消息仍会优先回应。"),
        new FieldSpec("chat.group.requireMention", "对话与参与", "参与方式", "仅被叫到时回应", "选择“沿用群聊开关”时，使用这个设置。"),
        new FieldSpec("chat.group.prefix", "对话与参与", "参与方式", "触发前缀", "群友以这个前缀开头，也能直接找小鲸聊天。"),
        new FieldSpec("social.keywords", "对话与参与", "参与方式", "参与关键词", "匹配这些话题时加入聊天；多个词用逗号分隔。"),
        new FieldSpec("social.responseProbability", "对话与参与", "参与方式", "旁聊参与概率", "概率模式下，决定参与普通群聊的机会。", "%", 0, 100, 5),
        new FieldSpec("chat.group.contextLines", "对话与参与", "上下文与跟进", "附加聊天记录", "每轮附带的近期群聊；0 表示不附加。", "条", 0, 30),
        new FieldSpec("chat.group.followUpMs", "对话与参与", "上下文与跟进", "连续追问窗口", "回应后，允许同一群友不重新 @ 继续追问。", "毫秒", 0, 600000, 1000),
        new FieldSpec("social.batchWindowMs", "对话与参与", "上下文与跟进", "消息聚合窗口", "稍等片刻，将连发的几句话放在一起处理。", "毫秒", 0, 5000, 100),
        new FieldSpec("social.activeMinutes", "对话与参与", "上下文与跟进", "话题活跃时间", "参与一个话题后，可以持续跟进的时间。", "分钟", 0, 60),
        new FieldSpec("chat.group.cooldownMs", "对话与参与", "上下文与跟进", "普通群聊冷却", "控制旁聊回应的频率，直接对话不受此项限制。", "毫秒", 0, 60000, 500),
        new FieldSpec("social.autonomy", "联系与权限", "执行方式", "QQ 动作执行方式", "自主执行、仅敏感动作确认，或所有动作确认。"),
        new FieldSpec("social.allowAll", "联系与权限", "联系人范围", "允许现有好友和群", "允许联系已有对象；屏蔽名单始终优先。"),
        new FieldSpec("social.allowedGroups", "联系与权限", "联系人范围", "允许的群号", "关闭“允许现有好友和群”后生效；用逗号分隔。"),
        new FieldSpec("social.allowedUsers", "联系与权限", "联系人范围", "允许的好友 QQ", "关闭“允许现有好友和群”后生效；用逗号分隔。"),
        new FieldSpec("social.blockedGroups", "联系与权限", "屏蔽名单", "屏蔽的群", "这些群不触发回应，也不接收主动消息。"),
        new FieldSpec("social.blockedUsers", "联系与权限", "屏蔽名单", "屏蔽的用户", "这些用户的后续发言不会进入模型上下文。"),
        new FieldSpec("social.memoryEnabled", "功能与媒体", "日常能力", "群友长期记忆", "记住偏好与重要事实，可在 QQ 活动里编辑。"),
        new FieldSpec("social.stickersEnabled", "功能与媒体", "日常能力", "本地表情库", "允许收藏、理解、查找和发送表情。"),
        new FieldSpec("social.mediaEnabled", "功能与媒体", "日常能力", "图片、语音与视频", "图片优先交给现有模型；语音和视频需相应服务。"),
        new FieldSpec("social.filesEnabled", "功能与媒体", "日常能力", "文件收发", "允许制作文本、接收文件和发送媒体库文件。"),
        new FieldSpec("social.requestsEnabled", "功能与媒体", "日常能力", "好友与群申请", "允许理解并处理真实收到的申请和邀请。"),
        new FieldSpec("features.qzone.enabled", "功能与媒体", "空间与发布", "QQ 空间发布", "依赖所部署协议端的空间接口支持。"),
        new FieldSpec("features.qzone.requireConfirm", "功能与媒体", "空间与发布", "发布前确认", "开启后，空间发布仍需管理员确认实际内容。"),
        new FieldSpec("social.visionModel", "功能与媒体", "媒体模型", "独立视觉模型", "留空时将图片交给 DSH 当前模型处理。"),
        new FieldSpec("social.transcriptionModel", "功能与媒体", "媒体模型", "语音转写模型", "先在连接与运行中配置媒体服务地址和密钥。"),
        new FieldSpec("social.speechModel", "功能与媒体", "媒体模型", "语音合成模型", "未配置时，语音合成会明确显示不可用。"),
        new FieldSpec("social.speechVoice", "功能与媒体", "媒体模型", "合成声音", "填写媒体服务支持的声音名称。"),
        new FieldSpec("social.videoFrames", "功能与媒体", "媒体模型", "视频抽帧数量", "需要已配置 FFmpeg 和可用视觉能力。", "帧", 1, 12),
        new FieldSpec("social.remindersEnabled", "主动与提醒", "提醒与主动机会", "定时提醒", "允许设置、查询和取消持久化提醒。"),
        new FieldSpec("social.proactiveEnabled", "主动与提醒", "提醒与主动机会", "主动聊天机会", "定期判断是否值得开口；没有话题时可以保持安静。"),
        new FieldSpec("social.proactiveIntervalMinutes", "主动与提醒", "提醒与主动机会", "主动机会间隔", "从最近一次互动或主动机会开始计时。", "分钟", 5, 1440, 5),
        new FieldSpec("chat.group.proactive.enabled", "主动与提醒", "群聊与安静时段", "允许群聊主动发言", "跨群发送和群提醒也受此开关约束。"),
        new FieldSpec("social.quietStartHour", "主动与提醒", "群聊与安静时段", "安静时段开始", "按上海时间计算；只暂停主动聊天机会。", "时", 0, 23),
        new FieldSpec("social.quietEndHour", "主动与提醒", "群聊与安静时段", "安静时段结束", "开始与结束相同表示不设置安静时段。", "时", 0, 23),
        new FieldSpec("social.actionsPerDay", "额度与节奏", "每日额度", "QQ 动作总额", "0 表示禁止；按上海时间每天零点重置。", "次/天", 0, 10000, 10),
        new FieldSpec("budgets.proactiveMessagesPerDay", "额度与节奏", "每日额度", "主动消息", "跨会话发送、主动聊天和提醒共享此额度。", "条/天", 0, 100),
        new FieldSpec("chat.group.proactive.perGroupPerDay", "额度与节奏", "每日额度", "每群主动消息", "还会同时受到全局主动消息额度限制。", "条/天", 0, 20),
        new FieldSpec("budgets.likesPerDay", "额度与节奏", "每日额度", "名片点赞", "按实际点赞次数扣除。", "次/天", 0, 200, 5),
        new FieldSpec("features.qzone.dailyLimit", "额度与节奏", "每日额度", "空间发布", "每日允许发布空间内容的次数。", "次/天", 0, 10),
        new FieldSpec("social.messagesPerMinute", "额度与节奏", "回复节奏", "会话操作频率", "限制同一会话一分钟内的动作次数。", "次/分", 1, 100),
        new FieldSpec("chat.delay.minMs", "额度与节奏", "回复节奏", "最短回复延迟", "最短延迟不能大于最长延迟。", "毫秒", 0, 10000, 100),
        new FieldSpec("chat.delay.maxMs", "额度与节奏", "回复节奏", "最长回复延迟", "在范围内选择自然的发送间隔。", "毫秒", 0, 20000, 100),
        new FieldSpec("chat.delay.chunkSize", "额度与节奏", "回复节奏", "长消息分段", "超过这个长度时分条发送。", "字", 100, 4000, 100),
        new FieldSpec("identity.name", "身份与审批", "小鲸的身份", "机器人名称", "群友在句首叫这个名字，也能唤起小鲸。"),
        new FieldSpec("approval.adminQq", "身份与审批", "工作区审批", "管理员 QQ", "接收工作区修改和命令执行的审批；0 表示未设置。", "", 0, long.MaxValue),
        new FieldSpec("approval.allowExec", "身份与审批", "工作区审批", "自动执行命令", "独立于 QQ 动作的自主开关，控制 DSH 命令执行。"),
        new FieldSpec("approval.timeoutMs", "身份与审批", "工作区审批", "审批等待时间", "超时后自动取消本次审批。", "毫秒", 5000, 600000, 5000),
        new FieldSpec("social.retentionDays", "存储与高级", "本地记录", "消息保留时间", "过期消息会在后续保存时淘汰。", "天", 1, 365),
        new FieldSpec("social.messagesPerChat", "存储与高级", "本地记录", "每会话消息上限", "保留最近的消息，不影响独立存储的长期记忆。", "条", 80, 20000, 100),
        new FieldSpec("features.browsing.enabled", "存储与高级", "预留的浏览器配置", "浏览器开关", "这组设置尚未接入外部浏览器工具。"),
        new FieldSpec("features.browsing.maxNavigations", "存储与高级", "预留的浏览器配置", "导航次数上限", "预留项，目前不会影响外部浏览器。", "次", 1, 10),
        new FieldSpec("features.browsing.maxScreenshots", "存储与高级", "预留的浏览器配置", "截图次数上限", "预留项，目前不会影响外部浏览器。", "次", 0, 5)
    };
    static Brush Ink(string key) { return (Brush)Application.Current.Resources[key]; }
    static Brush Color(string value) { return (Brush)new BrushConverter().ConvertFromString(value); }
    static void InitSettingsView() {
        var nav = Find<ListBox>("SettingsNav");
        nav.SelectionChanged += (s,e) => { var item = nav.SelectedItem as SettingsCategory; if (item != null) { selectedCategory=item.Name; FilterSettings(); Find<ScrollViewer>("SettingsScroll").ScrollToTop(); } };
        Find<TextBox>("SettingsSearch").TextChanged += (s,e) => FilterSettings();
        Find<TextBox>("SettingsSearch").KeyDown += (s,e) => { if(e.Key==System.Windows.Input.Key.Escape){Find<TextBox>("SettingsSearch").Clear();e.Handled=true;} };
        window.SizeChanged+=(s,e)=>Find<Border>("SettingsNavHelp").Visibility=window.ActualHeight<780?Visibility.Collapsed:Visibility.Visible;
    }
    static Dictionary<string,object> FlattenSettings(Dictionary<string,object> data, string prefix = "") {
        var result = new Dictionary<string,object>();
        foreach (var pair in data) { var nested=pair.Value as Dictionary<string,object>; if(nested!=null) foreach(var child in FlattenSettings(nested,prefix+pair.Key+".")) result[child.Key]=child.Value; else result[prefix+pair.Key]=pair.Value; }
        return result;
    }
    static void BuildSettings(Dictionary<string,object> data, StackPanel panel) {
        panel.Children.Clear(); fields.Clear(); fieldViews.Clear(); settingsCards.Clear();
        var values=FlattenSettings(data);
        var specs=fieldSpecs.Where(s=>values.ContainsKey(s.Path)).ToList();
        foreach(var pair in values.Where(p=>!specs.Any(s=>s.Path==p.Key))) specs.Add(new FieldSpec(pair.Key,"存储与高级","其他设置",Label(pair.Key.Split('.').Last()),"按项目配置规则保存。"));
        foreach(var category in categoryNames) foreach(var group in specs.Where(s=>s.Category==category).GroupBy(s=>s.Card)) {
            var body=new StackPanel();
            var title=new DockPanel { Margin=new Thickness(0,0,0,5) };
            var number=new TextBlock { Text=group.Count()+" 项", Foreground=Ink("Muted"), FontSize=10, HorizontalAlignment=HorizontalAlignment.Right }; DockPanel.SetDock(number,Dock.Right); title.Children.Add(number);
            title.Children.Add(new TextBlock { Text=group.Key, FontSize=14, FontWeight=FontWeights.SemiBold }); body.Children.Add(title);
            var card=new SettingsCard { Category=category, Surface=new Border { Background=Brushes.White, CornerRadius=new CornerRadius(12), BorderBrush=Ink("Line"), BorderThickness=new Thickness(1), Padding=new Thickness(20,16,20,7), Margin=new Thickness(0,0,0,14), Child=body } };
            bool compact=group.All(s=>values[s.Path] is bool)||group.All(s=>!(values[s.Path] is string)&&!(values[s.Path] is bool)&&!(values[s.Path] is IEnumerable));
            Panel rows=compact?(Panel)new System.Windows.Controls.Primitives.UniformGrid {Columns=2}:new StackPanel();body.Children.Add(rows);
            int index=0;
            foreach(var spec in group) { var view=MakeSetting(spec,values[spec.Path],compact);if(compact)view.Row.Margin=new Thickness(index%2==0?0:12,0,index%2==0?12:0,7);index++;card.Rows.Add(view);rows.Children.Add(view.Row);fieldViews[spec.Path]=view; }
            settingsCards.Add(card);panel.Children.Add(card.Surface);
        }
        Find<ListBox>("SettingsNav").ItemsSource=categoryNames.Select((name,i)=>new SettingsCategory { Name=name, Description=categoryDescriptions[i], Count=specs.Count(s=>s.Category==name).ToString() }).ToList();
        Find<ListBox>("SettingsNav").SelectedItem=((IEnumerable<SettingsCategory>)Find<ListBox>("SettingsNav").ItemsSource).First(c=>c.Name==selectedCategory);
        Find<TextBlock>("SettingsCount").Text=values.Count+" 项设置 · "+categoryNames.Length+" 个分类";
        RefreshDependencies();FilterSettings();
    }
    static FieldView MakeSetting(FieldSpec spec, object value, bool compact=false) {
        var outer=new StackPanel { Margin=new Thickness(0,0,0,7) };
        var row=new Grid { Margin=new Thickness(0,12,0,3) };
        row.ColumnDefinitions.Add(new ColumnDefinition());row.ColumnDefinitions.Add(new ColumnDefinition { Width=new GridLength(value is bool?76:212) });
        var copy=new StackPanel { Margin=new Thickness(0,0,18,0), VerticalAlignment=VerticalAlignment.Center };
        copy.Children.Add(new TextBlock { Text=spec.Title, FontSize=12, FontWeight=FontWeights.Medium, TextWrapping=TextWrapping.Wrap });
        copy.Children.Add(new TextBlock { Text=spec.Help, Foreground=Ink("Muted"), FontSize=10, TextWrapping=TextWrapping.Wrap, LineHeight=17, Margin=new Thickness(0,5,0,0) });
        row.Children.Add(copy);Control input;FrameworkElement holder;
        var error=new TextBlock { Foreground=Ink("Danger"), FontSize=10, Margin=new Thickness(0,4,0,0), TextWrapping=TextWrapping.Wrap, Visibility=Visibility.Collapsed };
        bool list=value is IEnumerable && !(value is string); bool numeric=!(value is bool)&&!(value is string)&&!list;
        if(value is bool) { var check=new CheckBox { IsChecked=(bool)value, HorizontalAlignment=HorizontalAlignment.Right };check.Checked+=(s,e)=>SettingChanged();check.Unchecked+=(s,e)=>SettingChanged();input=check;holder=check; }
        else if(choices.ContainsKey(spec.Path)) { var select=new ComboBox { ItemsSource=choices[spec.Path].Select(item=>new Choice { Value=item.Split('|')[0],Label=item.Split('|')[1] }).ToList(),DisplayMemberPath="Label",SelectedValuePath="Value",SelectedValue=value };select.SelectionChanged+=(s,e)=>SettingChanged();input=select;holder=select; }
        else {
            var text=new TextBox { Text=list?string.Join(", ",((IEnumerable)value).Cast<object>()):Convert.ToString(value,CultureInfo.InvariantCulture), Tag=list?"多个值用逗号分隔":spec.Path.StartsWith("social.")&&spec.Path.Contains("Model")?"可选模型名称":"", VerticalAlignment=VerticalAlignment.Center };
            text.TextChanged+=(s,e)=>SettingChanged();input=text;holder=text;
            if(numeric) {
                var box=new Grid();box.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(28)});box.ColumnDefinitions.Add(new ColumnDefinition());box.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});box.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(28)});
                var minus=new Button { Content="−",Padding=new Thickness(0),MinHeight=34,Background=Brushes.Transparent,BorderThickness=new Thickness(0),ToolTip="减少" };
                var plus=new Button { Content="+",Padding=new Thickness(0),MinHeight=34,Background=Brushes.Transparent,BorderThickness=new Thickness(0),ToolTip="增加" };
                Action<long> step=direction=> { long current; if(!long.TryParse(text.Text,out current))current=spec.Min; text.Text=direction>0?Math.Min(spec.Max,current>spec.Max-spec.Step?spec.Max:current+spec.Step).ToString():Math.Max(spec.Min,current<spec.Min+spec.Step?spec.Min:current-spec.Step).ToString();ValidateSetting(spec,text,error); };
                minus.Click+=(s,e)=>step(-1);plus.Click+=(s,e)=>step(1);
                System.Windows.Automation.AutomationProperties.SetName(minus,"减少"+spec.Title);System.Windows.Automation.AutomationProperties.SetName(plus,"增加"+spec.Title);
                text.BorderThickness=new Thickness(0);text.Background=Brushes.Transparent;text.Padding=new Thickness(4,8,2,8);text.MinHeight=34;text.HorizontalContentAlignment=HorizontalAlignment.Center;
                Grid.SetColumn(text,1);Grid.SetColumn(plus,3);box.Children.Add(minus);box.Children.Add(text);box.Children.Add(plus);
                if(spec.Unit.Length>0) {var unit=new TextBlock {Text=spec.Unit,FontSize=10,Foreground=Ink("Muted"),VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(0,0,5,0)};Grid.SetColumn(unit,2);box.Children.Add(unit);}
                holder=new Border {Background=Color("#FAFBFE"),BorderBrush=Color("#DEE5F0"),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(8),Child=box};
                text.LostKeyboardFocus+=(s,e)=>ValidateSetting(spec,text,error);
            }
            if(list) { row.ColumnDefinitions[1].Width=new GridLength(0);Grid.SetColumnSpan(copy,2);outer.Children.Add(row);text.TextWrapping=TextWrapping.Wrap;text.AcceptsReturn=true;text.MinHeight=52;text.VerticalContentAlignment=VerticalAlignment.Top;text.Margin=new Thickness(0,8,0,3);outer.Children.Add(text); }
        }
        System.Windows.Automation.AutomationProperties.SetName(input,spec.Title);System.Windows.Automation.AutomationProperties.SetAutomationId(input,"Setting-"+spec.Path);fields[spec.Path]=input;
        if(!list) {
            if(compact&&numeric){row.ColumnDefinitions[1].Width=new GridLength(0);Grid.SetColumnSpan(copy,2);outer.Children.Add(row);holder.Margin=new Thickness(0,9,0,2);outer.Children.Add(holder);}
            else {Grid.SetColumn(holder,1);row.Children.Add(holder);outer.Children.Add(row);}
        }outer.Children.Add(error);
        outer.Children.Add(new Border { Background=Color("#F0F3F9"),Height=1,Margin=new Thickness(0,11,0,0) });
        return new FieldView {Spec=spec,Row=outer,Editor=holder,Error=error};
    }
    static void SettingChanged() { MarkDirty("settings"); if(!loading) { RefreshDependencies();Find<TextBlock>("SettingsSaveHint").Text="有尚未保存的更改"; } }
    static void RefreshDependencies() {
        Action<string,bool> enabled=(key,on)=>{if(fields.ContainsKey(key)){fields[key].IsEnabled=on;if(fieldViews.ContainsKey(key))fieldViews[key].Editor.IsEnabled=on;}};
        if(fields.ContainsKey("social.allowAll")) {bool allow=((CheckBox)fields["social.allowAll"]).IsChecked==true;enabled("social.allowedGroups",!allow);enabled("social.allowedUsers",!allow);}
        if(fields.ContainsKey("social.responseMode")) {var choice=((ComboBox)fields["social.responseMode"]).SelectedItem as Choice;string mode=choice==null?"":choice.Value;enabled("chat.group.requireMention",mode=="legacy");enabled("social.responseProbability",mode=="probability");enabled("social.keywords",mode=="keywords"||mode=="probability");}
        if(fields.ContainsKey("social.proactiveEnabled")) {bool on=((CheckBox)fields["social.proactiveEnabled"]).IsChecked==true;foreach(string key in new[]{"social.proactiveIntervalMinutes","social.quietStartHour","social.quietEndHour"})enabled(key,on);}
    }
    static void FilterSettings() {
        if(Find<TextBox>("SettingsSearch")==null||settingsCards.Count==0)return;
        string query=Find<TextBox>("SettingsSearch").Text.Trim();int count=0;
        foreach(var card in settingsCards) {bool show=false;foreach(var view in card.Rows){bool match=query.Length==0?card.Category==selectedCategory:(view.Spec.Title+view.Spec.Help+view.Spec.Path+card.Category+view.Spec.Card).IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0;view.Row.Visibility=match?Visibility.Visible:Visibility.Collapsed;if(match){show=true;count++;}}card.Surface.Visibility=show?Visibility.Visible:Visibility.Collapsed;}
        Find<TextBlock>("SettingsTitle").Text=query.Length==0?selectedCategory:"搜索结果";
        Find<TextBlock>("SettingsSubtitle").Text=query.Length==0?categoryDescriptions[Array.IndexOf(categoryNames,selectedCategory)]:"找到 "+count+" 项相关设置，清空搜索可返回分类。";
        Find<StackPanel>("SettingsEmpty").Visibility=count==0?Visibility.Visible:Visibility.Collapsed;
    }
    static bool ValidateSetting(FieldSpec spec,TextBox text,TextBlock error) {
        long value;bool valid=long.TryParse(text.Text,out value)&&value>=spec.Min&&value<=spec.Max;
        error.Text=valid?"":"请输入 "+spec.Min+"–"+spec.Max+" 之间的整数。";error.Visibility=valid?Visibility.Collapsed:Visibility.Visible;
        return valid;
    }
    static bool ValidateSettingsForm() {
        foreach(var view in fieldViews.Values) {var input=fields[view.Spec.Path] as TextBox;if(input==null)continue;object value=FlattenSettings(settings)[view.Spec.Path];if(value is string||value is IEnumerable)continue;if(!ValidateSetting(view.Spec,input,view.Error)){Find<TextBox>("SettingsSearch").Clear();Find<ListBox>("SettingsNav").SelectedItem=((IEnumerable<SettingsCategory>)Find<ListBox>("SettingsNav").ItemsSource).First(c=>c.Name==view.Spec.Category);view.Row.BringIntoView();input.Focus();Feedback(view.Spec.Title+"需要调整，请检查提示。");return false;}}
        return true;
    }
    static void VerifySettingsInteraction() {
        if(Find<ListBox>("SettingsNav").Items.Count!=7)throw new Exception("设置分类不完整");
        string before=json.Serialize(Collect(settings,""));
        var mode=(ComboBox)fields["social.responseMode"];object originalMode=mode.SelectedValue;
        var number=(TextBox)fields["social.responseProbability"];string originalNumber=number.Text;
        mode.SelectedValue="probability";
        if(!number.IsEnabled)throw new Exception("参与方式没有更新相关控件");
        number.Text="10";
        var editor=(Border)fieldViews["social.responseProbability"].Editor;
        ((Grid)editor.Child).Children.OfType<Button>().Last().RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        if(number.Text!="15")throw new Exception("数字步进没有生效");
        number.Text="101";
        if(ValidateSettingsForm()||fieldViews["social.responseProbability"].Error.Visibility!=Visibility.Visible)throw new Exception("无效值没有显示行内提示");
        number.Text=originalNumber;ValidateSetting(fieldViews["social.responseProbability"].Spec,number,fieldViews["social.responseProbability"].Error);mode.SelectedValue=originalMode;
        Find<TextBox>("SettingsSearch").Text="主动消息";
        if(!settingsCards.Any(c=>c.Surface.Visibility==Visibility.Visible))throw new Exception("设置搜索没有匹配结果");
        Find<TextBox>("SettingsSearch").Clear();
        var name=(TextBox)fields["identity.name"];string originalName=name.Text;name.Text="测试中的名称";Find<ListBox>("SettingsNav").SelectedIndex=6;Find<ListBox>("SettingsNav").SelectedIndex=5;if(name.Text!="测试中的名称")throw new Exception("切换分类丢失了未保存输入");name.Text=originalName;
        if(json.Serialize(Collect(settings,""))!=before)throw new Exception("切换分类或搜索丢失了设置值");
        for(int i=0;i<7;i++){Find<ListBox>("SettingsNav").SelectedIndex=i;Capture(System.IO.Path.Combine(root,"settings-"+i+".png"),2);}
        Find<ListBox>("SettingsNav").SelectedIndex=0;
    }
    static void BuildRuntimeFields(object value) {
        var panel=Find<StackPanel>("RuntimeFields");panel.Children.Clear();runtimeInputs.Clear();
        var all=((IEnumerable)value).Cast<Dictionary<string,object>>().ToList();
        Func<string,int> order=group=>group.StartsWith("OneBot")?0:group.StartsWith("模型")?1:group.StartsWith("账号")?2:group.StartsWith("图片")?3:group.StartsWith("搜索")?4:group.StartsWith("消息")?5:group.StartsWith("社交")?6:group.StartsWith("数据")?7:8;
        foreach(var group in all.GroupBy(f=>(string)f["group"]).OrderBy(g=>order(g.Key))) {
            var content=new StackPanel {Margin=new Thickness(0,13,0,0)};
            foreach(var field in group) {
                string key=(string)field["key"],kind=(string)field["kind"];
                var row=new StackPanel {Margin=new Thickness(0,0,0,14)};row.Children.Add(new TextBlock {Text=(string)field["label"],FontSize=12,Margin=new Thickness(0,0,0,7),TextWrapping=TextWrapping.Wrap});
                Control input;
                if(kind=="secret") {var password=new PasswordBox {Password=(string)field["value"]};password.PasswordChanged+=(s,e)=>MarkDirty("runtime");input=password;}
                else {var text=new TextBox {Text=(string)field["value"]};text.TextChanged+=(s,e)=>MarkDirty("runtime");input=text;}
                runtimeInputs[key]=input;System.Windows.Automation.AutomationProperties.SetName(input,(string)field["label"]);
                var holder=new DockPanel();
                if(kind=="file"||kind=="folder") {var browse=new Button {Content="选择…",Margin=new Thickness(8,0,0,0)};browse.Click+=(s,e)=>{if(kind=="folder"){using(var dialog=new Forms.FolderBrowserDialog()){if(dialog.ShowDialog()==Forms.DialogResult.OK)((TextBox)input).Text=dialog.SelectedPath;}}else{var dialog=new Microsoft.Win32.OpenFileDialog {Filter="所有文件|*.*"};if(dialog.ShowDialog(window)==true)((TextBox)input).Text=dialog.FileName;}};DockPanel.SetDock(browse,Dock.Right);holder.Children.Add(browse);}
                holder.Children.Add(input);row.Children.Add(holder);content.Children.Add(row);
            }
            var expander=new Expander {Header=group.Key,FontSize=14,FontWeight=FontWeights.Medium,IsExpanded=order(group.Key)<2,Content=content};
            panel.Children.Add(new Border {Background=Brushes.White,BorderBrush=Ink("Line"),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(12),Padding=new Thickness(18,15,18,5),Margin=new Thickness(0,0,8,14),Child=expander});
        }
    }
}
