using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using Forms = System.Windows.Forms;

partial class App
{
    static readonly string[] runtimeCategories = { "QQ 连接", "对话模型", "媒体服务", "运行与队列", "扩展服务", "存储与高级" };
    static readonly string[] runtimeDescriptions = {
        "连接机器人账号与 OneBot 服务，令牌需与 NapCat 中的设置一致。",
        "为本项目选择模型、管理 API Key，并测试实际连接。",
        "集中配置媒体服务、模型名称与声音；留空视觉模型时沿用对话模型。",
        "设置模型等待时间、并发数和消息队列容量；回复节奏在机器人设置管理。",
        "配置搜索和空间适配服务；对应功能开关在机器人设置管理。",
        "管理工作区之外的数据文件位置和高级环境文件；行为参数在机器人设置管理。"
    };
    static readonly string[] mediaKeys = { "visionModel", "transcriptionModel", "speechModel", "speechVoice", "videoFrames" };
    static readonly Dictionary<string,long[]> runtimeRanges = new Dictionary<string,long[]> {
        {"TURN_TIMEOUT_MS",new long[]{1000,600000}}, {"QUEUE_PER_CONVERSATION",new long[]{1,100}},
        {"QUEUE_TOTAL",new long[]{1,1000}}, {"MAX_CONCURRENT_TURNS",new long[]{1,32}},
        {"BOT_SELF_ID",new long[]{0,9007199254740991}}, {"ADMIN_QQ",new long[]{0,9007199254740991}}
    };
    static readonly Dictionary<string,string> runtimeHelp = new Dictionary<string,string> {
        {"BOT_DSH_BIN","选择 dsh.cmd 或 DSH 可执行文件。"},
        {"BOT_DSH_PROFILE","提供基础工具与运行环境；上方可为本项目单独选择对话模型。"},
        {"BOT_CHAT_MODE","沿用已有设置，或为本项目使用独立的 API Key；账号模式复用 DSH 的登录态。"},
        {"BOT_CHAT_MODEL","可获取模型列表后选择，也可直接填写服务支持的模型 ID。"},
        {"QQ_BOT_DEEPSEEK_API_KEY","仅用于当前项目。密钥隐藏显示，保存到本地配置。"},
        {"BOT_CHAT_BASE_URL","默认使用 DeepSeek 官方接口；自定义服务需兼容 Messages 协议。"},
        {"BOT_DSH_HOME","留空使用当前用户的 .dsh 目录。"},
        {"BOT_WORKSPACE","用于人设、记忆和生成文件；应选择已存在的目录。切换后请重新打开工作台加载对应人设。"},
        {"BOT_SETTINGS_FILE","保存后加载目标文件的机器人设置；运行中的机器人需重启后使用目标文件。"},
        {"BOT_MEDIA_BASE_URL","填写兼容 API 的基础地址，如 https://api.example.com/v1/；语音和独立视觉模型共用此服务。"},
        {"BOT_MEDIA_API_KEY","媒体服务的 API 密钥，输入内容会隐藏。"},
        {"BOT_FFMPEG_BIN","仅视频抽帧需要；选择 FFmpeg 可执行文件。"},
        {"BOT_SEARCH_URL","用于 QQ 搜索工具；DSH 自带或已挂载的搜索工具另行配置。"},
        {"BOT_QZONE_ADAPTER_URL","仅浏览和评论空间需要；发布说说使用协议端接口，开关与确认在机器人设置管理。"},
        {"TURN_TIMEOUT_MS","1000–600000 毫秒，超时后取消本轮并在下次重建会话。"},
        {"MAX_CONCURRENT_TURNS","1–32 个会话；并发越高，对模型服务的负载越大。"},
        {"QUEUE_PER_CONVERSATION","1–100 条，包含正在处理的消息。"},
        {"QUEUE_TOTAL","1–1000 条，包含全部会话正在处理和等待的消息。"}
    };
    static Dictionary<string,TextBlock> runtimeErrors = new Dictionary<string,TextBlock>();
    static Dictionary<string,string> savedRuntimeValues = new Dictionary<string,string>();
    static Dictionary<FrameworkElement,int> runtimeCards = new Dictionary<FrameworkElement,int>();
    static Dictionary<string,Control> mediaInputs = new Dictionary<string,Control>();
    static Dictionary<string,TextBlock> mediaErrors = new Dictionary<string,TextBlock>();
    static TextBlock mediaSummary;
    static TextBlock chatModelSummary, chatModelResult;
    static Button chatModelTest, chatModelList;
    static bool chatModelBusy;
    static bool runtimeBusy, connectionRestartPending;
    static void UpdateConnectionEditing() {
        bool envDirty=dirtySections.Contains("env"),formDirty=dirtySections.Contains("runtime")||dirtySections.Contains("models");
        Find<TextBox>("Env").IsReadOnly=formDirty;
        Find<TextBox>("Env").ToolTip=formDirty?"请先保存连接与媒体表单，再编辑高级环境文件。":null;
        Find<StackPanel>("RuntimeFields").IsEnabled=!envDirty;
        Find<StackPanel>("RuntimeFields").Opacity=envDirty?0.55:1;
        Find<Button>("SaveEnv").IsEnabled=!formDirty&&!chatModelBusy;
        Find<Button>("SaveRuntime").IsEnabled=!envDirty&&!chatModelBusy;
        Find<Button>("SaveRuntimeRestart").IsEnabled=!envDirty&&!runtimeBusy&&!chatModelBusy;
        if(envDirty)Find<TextBlock>("RuntimeHint").Text="正在编辑高级文本，请先保存高级文本。";
    }
    static string RuntimeValue(string key) {
        var control=runtimeInputs[key];var combo=control as ComboBox;
        return control is PasswordBox?((PasswordBox)control).Password:combo!=null?(combo.IsEditable?combo.Text:combo.SelectedItem is ComboBoxItem?Convert.ToString(((ComboBoxItem)combo.SelectedItem).Tag):Convert.ToString(combo.SelectedValue)):((TextBox)control).Text;
    }
    static bool IsMediaSetting(string path) { return mediaKeys.Any(key=>path=="social."+key); }
    static int RuntimeCategory(string group) {
        return group.StartsWith("OneBot")||group.StartsWith("账号")?0:group.StartsWith("模型")?1:group.StartsWith("媒体")||group.StartsWith("图片")?2:group.StartsWith("消息")?3:group.StartsWith("搜索")||group.StartsWith("空间")?4:5;
    }
    static void InitRuntimeView() {
        var nav=Find<ListBox>("RuntimeNav");nav.ItemsSource=runtimeCategories;
        nav.SelectionChanged+=(s,e)=>{FilterRuntime();Find<ScrollViewer>("RuntimeScroll").ScrollToTop();};nav.SelectedIndex=0;
    }
    static void FilterRuntime() {
        int category=Math.Max(0,Find<ListBox>("RuntimeNav").SelectedIndex);
        foreach(var card in runtimeCards)card.Key.Visibility=card.Value==category?Visibility.Visible:Visibility.Collapsed;
        Find<TextBlock>("RuntimeTitle").Text=runtimeCategories[category];Find<TextBlock>("RuntimeSubtitle").Text=runtimeDescriptions[category];
        Find<Expander>("AdvancedEnv").Visibility=category==5?Visibility.Visible:Visibility.Collapsed;
    }
    static void NavigateRuntime(int category) {Find<TabControl>("Tabs").SelectedIndex=3;Find<ListBox>("RuntimeNav").SelectedIndex=category;Find<ScrollViewer>("RuntimeScroll").ScrollToTop();}
    static Border RuntimeCard(string title,string help,Panel body,int category) {
        var content=new StackPanel();content.Children.Add(new TextBlock {Text=title,FontSize=14,FontWeight=FontWeights.SemiBold});
        if(help.Length>0)content.Children.Add(new TextBlock {Text=help,FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=18,Margin=new Thickness(0,7,0,0)});
        body.Margin=new Thickness(0,16,0,0);content.Children.Add(body);
        var card=new Border {Style=(Style)window.FindResource("Surface"),CornerRadius=new CornerRadius(12),Padding=new Thickness(20,18,20,6),Margin=new Thickness(0,0,0,14),Child=content};
        runtimeCards[card]=category;return card;
    }
    static void BuildRuntimeFields(object value) {
        var panel=Find<StackPanel>("RuntimeFields");panel.Children.Clear();runtimeInputs.Clear();runtimeErrors.Clear();runtimeCards.Clear();mediaInputs.Clear();mediaErrors.Clear();
        var all=((IEnumerable)value).Cast<Dictionary<string,object>>().ToList();
        savedRuntimeValues=all.ToDictionary(field=>(string)field["key"],field=>(string)field["value"]);
        foreach(var group in all.Where(f=>!f.ContainsKey("initialDefault")||!(bool)f["initialDefault"]).GroupBy(f=>(string)f["group"]).OrderBy(g=>RuntimeCategory(g.Key))) {
            var content=new StackPanel();
            foreach(var field in group) {
                string key=(string)field["key"],kind=(string)field["kind"],label=(string)field["label"];
                var row=new Grid {Margin=new Thickness(0,0,0,16)};row.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});row.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1.35,GridUnitType.Star)});
                var copy=new StackPanel {Margin=new Thickness(0,3,24,0)};copy.Children.Add(new TextBlock {Text=label,FontSize=12,TextWrapping=TextWrapping.Wrap});
                if(runtimeHelp.ContainsKey(key))copy.Children.Add(new TextBlock {Text=runtimeHelp[key],FontSize=10,Foreground=Ink("Muted"),LineHeight=17,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,5,0,0)});
                copy.Children.Add(new TextBlock{Text="保存后需重启",FontSize=10,Foreground=Ink("Accent"),Margin=new Thickness(0,5,0,0)});
                row.Children.Add(copy);Control input;
                if(kind=="chat-mode") {
                    var combo=new ComboBox {SelectedValuePath="Tag"};
                    combo.Items.Add(new ComboBoxItem {Content="沿用 DSH Profile",Tag="profile"});combo.Items.Add(new ComboBoxItem {Content="本项目 API Key",Tag="project"});combo.Items.Add(new ComboBoxItem {Content="DeepSeek 账号登录",Tag="account"});
                    combo.SelectedValue=(string)field["value"];combo.SelectionChanged+=(s,e)=>RuntimeChanged();input=combo;
                }
                else if(kind=="chat-model") {
                    var combo=new ComboBox {IsEditable=true,IsTextSearchEnabled=false,ItemsSource=new[]{"deepseek-flash","deepseek-v4-pro"},Text=(string)field["value"]};
                    combo.AddHandler(TextBox.TextChangedEvent,new TextChangedEventHandler((s,e)=>RuntimeChanged()));combo.LostKeyboardFocus+=(s,e)=>ValidateRuntimeField(key);input=combo;
                }
                else if(kind=="secret") {var password=new PasswordBox {Password=(string)field["value"]};password.PasswordChanged+=(s,e)=>RuntimeChanged();password.LostKeyboardFocus+=(s,e)=>ValidateRuntimeField(key);input=password;}
                else {var text=new TextBox {Text=(string)field["value"]};text.TextChanged+=(s,e)=>RuntimeChanged();text.LostKeyboardFocus+=(s,e)=>ValidateRuntimeField(key);input=text;}
                runtimeInputs[key]=input;System.Windows.Automation.AutomationProperties.SetName(input,label);System.Windows.Automation.AutomationProperties.SetAutomationId(input,"Runtime-"+key);
                var editor=new StackPanel();var holder=new DockPanel();
                if(kind=="file"||kind=="folder") {
                    var browse=new Button {Content="浏览…",Margin=new Thickness(8,0,0,0),Padding=new Thickness(10,8,10,8)};
                    System.Windows.Automation.AutomationProperties.SetName(browse,"选择"+label);
                    browse.Click+=(s,e)=>{if(kind=="folder"){using(var dialog=new Forms.FolderBrowserDialog()){if(dialog.ShowDialog()==Forms.DialogResult.OK)((TextBox)input).Text=dialog.SelectedPath;}}else{var dialog=new Microsoft.Win32.OpenFileDialog {Filter="启动文件|*.cmd;*.exe;*.bat|所有文件|*.*"};if(dialog.ShowDialog(window)==true)((TextBox)input).Text=dialog.FileName;}};
                    DockPanel.SetDock(browse,Dock.Right);holder.Children.Add(browse);
                }
                holder.Children.Add(input);editor.Children.Add(holder);
                var error=new TextBlock {Foreground=Ink("Danger"),FontSize=10,Margin=new Thickness(0,5,0,0),TextWrapping=TextWrapping.Wrap,Visibility=Visibility.Collapsed};runtimeErrors[key]=error;editor.Children.Add(error);
                Grid.SetColumn(editor,1);row.Children.Add(editor);content.Children.Add(row);
            }
            if(group.Key=="模型选择")BuildChatModelActions(content);
            string help=group.Key=="模型选择"?"配置只作用于本项目。模型切换后保留会话上下文；保存后重连模型即可应用。":group.Key.StartsWith("模型")?"DSH 启动文件、Profile 与模型运行目录。":group.Key.StartsWith("媒体")?"独立视觉、语音转写与语音合成使用同一媒体服务。填写下方需要的模型名称即可。":"";
            panel.Children.Add(RuntimeCard(group.Key,help,content,RuntimeCategory(group.Key)));
        }
        var shortcuts=new StackPanel();shortcuts.Children.Add(new TextBlock{Text="管理员 QQ、触发前缀、回复节奏和命令确认统一在机器人设置编辑。高级环境文件中的同名项仅补齐缺失默认值。",FontSize=11,TextWrapping=TextWrapping.Wrap,Foreground=Ink("Muted"),LineHeight=18});
        var openSettings=new Button{Content="前往机器人设置",Style=(Style)window.FindResource("Quiet"),HorizontalAlignment=HorizontalAlignment.Left,Margin=new Thickness(0,10,0,10)};openSettings.Click+=(s,e)=>NavigateSetting("approval.adminQq");shortcuts.Children.Add(openSettings);panel.Children.Add(RuntimeCard("行为设置入口","",shortcuts,5));
        BuildMediaEditors(panel);RefreshMediaEditors();RefreshChatModelEditor();FilterRuntime();
    }
    static void BuildChatModelActions(StackPanel content) {
        chatModelSummary=new TextBlock {FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,12)};content.Children.Add(chatModelSummary);
        var actions=new WrapPanel {Margin=new Thickness(0,0,0,10)};
        chatModelList=new Button {Content="获取模型",Style=(Style)window.FindResource("Quiet"),Margin=new Thickness(0,0,10,0)};
        chatModelTest=new Button {Content="测试连接",Style=(Style)window.FindResource("Quiet")};
        System.Windows.Automation.AutomationProperties.SetAutomationId(chatModelList,"ChatModel-List");System.Windows.Automation.AutomationProperties.SetAutomationId(chatModelTest,"ChatModel-Test");
        chatModelList.Click+=(s,e)=>RequestChatModel("list");chatModelTest.Click+=(s,e)=>RequestChatModel("test");actions.Children.Add(chatModelList);actions.Children.Add(chatModelTest);content.Children.Add(actions);
        content.Children.Add(new TextBlock {Text="测试连接会发送一条简短请求，可能产生少量费用；测试不会保存输入。",FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=18,Margin=new Thickness(0,0,0,8)});
        chatModelResult=new TextBlock {Text="尚未测试当前配置。",FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=18,Margin=new Thickness(0,0,0,16)};content.Children.Add(chatModelResult);
    }
    static void RefreshChatModelEditor() {
        if(chatModelSummary==null||!runtimeInputs.ContainsKey("BOT_CHAT_MODE")||!runtimeInputs.ContainsKey("BOT_CHAT_BASE_URL"))return;
        string mode=RuntimeValue("BOT_CHAT_MODE");bool project=mode=="project",custom=mode!="profile";
        runtimeInputs["BOT_CHAT_MODE"].IsEnabled=!chatModelBusy;runtimeInputs["BOT_CHAT_MODEL"].IsEnabled=custom&&!chatModelBusy;
        runtimeInputs["QQ_BOT_DEEPSEEK_API_KEY"].IsEnabled=project&&!chatModelBusy;runtimeInputs["BOT_CHAT_BASE_URL"].IsEnabled=project&&!chatModelBusy;
        chatModelList.IsEnabled=project&&!chatModelBusy;chatModelTest.IsEnabled=project&&!chatModelBusy;
        chatModelList.ToolTip=chatModelTest.ToolTip=project?null:"选择“本项目 API Key”后可获取模型和测试 API 连接。";
        chatModelSummary.Text=mode=="profile"?"当前沿用 DSH Profile 的模型与凭据。":mode=="account"?"使用 DSH 已登录的 DeepSeek 账号 · "+RuntimeValue("BOT_CHAT_MODEL"):"本项目独立配置 · "+RuntimeValue("BOT_CHAT_MODEL")+" · "+(RuntimeValue("QQ_BOT_DEEPSEEK_API_KEY").Length>0?"Key 已填写":"待填写 Key");
    }
    static void SetChatModelBusy(bool busy) {
        chatModelBusy=busy;RefreshChatModelEditor();UpdateConnectionEditing();
        if(!busy){if(chatModelTest!=null)chatModelTest.Content="测试连接";if(chatModelList!=null)chatModelList.Content="获取模型";}
    }
    static void RequestChatModel(string operation) {
        if(chatModelBusy)return;
        if(dirtySections.Contains("env")){Feedback("请先保存高级文本，再测试表单中的模型配置。");return;}
        foreach(string key in new[]{"BOT_CHAT_MODE","BOT_CHAT_MODEL","QQ_BOT_DEEPSEEK_API_KEY","BOT_CHAT_BASE_URL"})if(!ValidateRuntimeField(key)){runtimeInputs[key].Focus();return;}
        SetChatModelBusy(true);(operation=="list"?chatModelList:chatModelTest).Content=operation=="list"?"正在获取…":"正在测试…";
        chatModelResult.Text=operation=="list"?"正在获取可用模型…":"正在验证当前输入的 Key、模型与接口…";chatModelResult.Foreground=Ink("Muted");
        Send("model",new {operation=operation,runtime=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key))});
    }
    static void RenderChatModel(Dictionary<string,object> message) {
        SetChatModelBusy(false);
        if((string)message["operation"]=="list") {
            var combo=(ComboBox)runtimeInputs["BOT_CHAT_MODEL"];string current=combo.Text;
            combo.ItemsSource=((IEnumerable)message["models"]).Cast<object>().Select(item=>item.ToString()).ToArray();combo.Text=current;
        }
        chatModelResult.Text=(string)message["message"];chatModelResult.Foreground=Ink("Text");Feedback((string)message["message"]);
    }
    static void ChatModelError(string text) {
        SetChatModelBusy(false);if(chatModelResult!=null){chatModelResult.Text=text;chatModelResult.Foreground=Ink("Danger");}
    }
    static void BuildMediaEditors(StackPanel panel) {
        var body=new StackPanel();mediaSummary=new TextBlock {Foreground=Ink("Muted"),FontSize=11,TextWrapping=TextWrapping.Wrap,LineHeight=18,Margin=new Thickness(0,0,0,16)};body.Children.Add(mediaSummary);
        var openSwitch=new Button{Content="前往功能开关",Style=(Style)window.FindResource("Quiet"),HorizontalAlignment=HorizontalAlignment.Left,Margin=new Thickness(0,0,0,10)};openSwitch.Click+=(s,e)=>NavigateSetting("social.mediaEnabled");body.Children.Add(openSwitch);
        foreach(string key in mediaKeys) {
            string path="social."+key;if(!fields.ContainsKey(path))continue;var view=fieldViews[path];var input=(TextBox)fields[path];
            var parent=LogicalTreeHelper.GetParent(view.Row) as Panel;if(parent!=null)parent.Children.Remove(view.Row);
            input.Tag=key=="visionModel"?"留空沿用对话模型":key=="videoFrames"?"1–12 帧":"填写服务支持的名称";
            mediaInputs[key]=input;mediaErrors[key]=view.Error;System.Windows.Automation.AutomationProperties.SetAutomationId(input,"Media-"+key);
            SettingStatus(path,"保存后热更新");body.Children.Add(view.Row);
        }
        panel.Children.Add(RuntimeCard("模型与声音","媒体模型、声音和抽帧参数仅在这里编辑；媒体总开关在机器人设置的功能开关中管理。",body,2));
    }
    static void RuntimeChanged() {MarkDirty("runtime");if(!loading){Find<TextBlock>("RuntimeHint").Text="有尚未保存的连接配置；仅修改对话模型时会保留 QQ 登录。";if(chatModelResult!=null&&!chatModelBusy){chatModelResult.Text="配置有修改，可测试当前输入后保存。";chatModelResult.Foreground=Ink("Muted");}}RefreshMediaEditors();RefreshChatModelEditor();}
    static void RefreshMediaEditors() {
        if(mediaInputs.Count!=mediaKeys.Length)return;
        bool enabled=SavedMediaEnabled();
        foreach(var input in mediaInputs){input.Value.IsEnabled=true;fieldViews["social."+input.Key].Editor.IsEnabled=true;}
        bool service=runtimeInputs.ContainsKey("BOT_MEDIA_BASE_URL")&&RuntimeValue("BOT_MEDIA_BASE_URL").Trim().Length>0;
        Func<string,string> state=key=>((TextBox)fields["social."+key]).Text.Trim().Length==0?"未配置":service?"已填写":"待填写服务地址";
        mediaSummary.Text=(!enabled?"媒体能力已关闭；可先配置服务和模型，再前往功能开关开启并保存。":"视觉："+(((TextBox)fields["social.visionModel"]).Text.Trim().Length==0?"沿用对话模型（需支持图片）":state("visionModel"))+" · 转写："+state("transcriptionModel")+" · 合成："+state("speechModel"))+(dirtySettingPaths.Contains("social.mediaEnabled")?"\n功能开关有未保存修改，请在机器人设置单独保存。":"");
        var saved=(Dictionary<string,object>)settings["social"];string savedSummary="已保存模型：视觉 "+(Convert.ToString(saved["visionModel"]).Length==0?"沿用对话模型":Convert.ToString(saved["visionModel"]))+" · 转写 "+(Convert.ToString(saved["transcriptionModel"]).Length==0?"未配置":Convert.ToString(saved["transcriptionModel"]))+" · 合成 "+(Convert.ToString(saved["speechModel"]).Length==0?"未配置":Convert.ToString(saved["speechModel"]));
        SettingStatus("social.mediaEnabled",savedSummary+(dirtySections.Contains("models")?"；媒体服务还有未保存修改。":""));
    }
    static bool SavedMediaEnabled() {return settings!=null&&(bool)((Dictionary<string,object>)settings["social"])["mediaEnabled"];}
    static bool ValidateMediaField(string key) {
        if(!mediaErrors.ContainsKey(key)||fields["social."+key] is CheckBox)return true;
        string text=((TextBox)fields["social."+key]).Text,error="";int limit=key=="speechVoice"?64:128;long frames;
        if(key=="videoFrames"&&(!long.TryParse(text,out frames)||frames<1||frames>12))error="视频抽帧数量应为 1–12 之间的整数。";
        else if(key!="videoFrames"&&text.Length>limit)error="最多输入 "+limit+" 个字符。";
        mediaErrors[key].Text=error;mediaErrors[key].Visibility=error.Length==0?Visibility.Collapsed:Visibility.Visible;return error.Length==0;
    }
    static bool ValidateRuntimeField(string key) {
        if(!runtimeErrors.ContainsKey(key))return true;
        string value=RuntimeValue(key),error="";long number;Uri uri;
        if(runtimeRanges.ContainsKey(key)) {
            var range=runtimeRanges[key];if(!long.TryParse(value,out number)||value.Length==0||!value.All(c=>c>='0'&&c<='9')||number<range[0]||number>range[1])error="请输入 "+range[0]+"–"+range[1]+" 之间的整数。";
        }
        else if(key=="BOT_CHAT_MODE"&&!new[]{"profile","project","account"}.Contains(value))error="请选择有效的模型使用方式。";
        else if(key=="BOT_CHAT_MODEL"&&RuntimeValue("BOT_CHAT_MODE")!="profile"&&(value.Length==0||value.Length>128||value.Any(c=>char.IsWhiteSpace(c)||char.IsControl(c))))error="请输入 1–128 个字符的模型 ID，不可包含空白。";
        else if(key=="QQ_BOT_DEEPSEEK_API_KEY"&&RuntimeValue("BOT_CHAT_MODE")=="project"&&(value.Length==0||value.Length>512||value.Any(c=>char.IsWhiteSpace(c)||char.IsControl(c))))error="请填写本项目的 API Key，不可包含空白。";
        else if(key=="BOT_CHAT_BASE_URL"&&RuntimeValue("BOT_CHAT_MODE")=="project"&&(!Uri.TryCreate(value,UriKind.Absolute,out uri)||(uri.Scheme!="http"&&uri.Scheme!="https")||uri.UserInfo.Length>0||uri.Query.Length>0||uri.Fragment.Length>0))error="请输入 HTTP(S) 接口地址，不可包含账号或查询参数。";
        else if(key=="BOT_DSH_PROFILE"&&value.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(value,@"^[A-Za-z0-9_-]+$"))error="Profile 只允许字母、数字、下划线和短横线。";
        else if((key=="ONEBOT_HTTP_URL"||key=="ONEBOT_WS_URL"||key.EndsWith("_URL"))&&(key!="BOT_CHAT_BASE_URL"||RuntimeValue("BOT_CHAT_MODE")=="project")) {
            bool websocket=key=="ONEBOT_WS_URL";
            if(value.Length>0&&(!Uri.TryCreate(value,UriKind.Absolute,out uri)||(websocket?uri.Scheme!="ws"&&uri.Scheme!="wss":uri.Scheme!="http"&&uri.Scheme!="https")))error=websocket?"请输入 ws:// 或 wss:// 开头的地址。":"请输入 http:// 或 https:// 开头的地址。";
        }
        runtimeErrors[key].Text=error;runtimeErrors[key].Visibility=error.Length==0?Visibility.Collapsed:Visibility.Visible;return error.Length==0;
    }
    static bool ValidateConnectionForm() {
        foreach(string key in runtimeInputs.Keys)if(!ValidateRuntimeField(key)) {Find<ListBox>("RuntimeNav").SelectedIndex=RuntimeCategoryForKey(key);runtimeInputs[key].BringIntoView();runtimeInputs[key].Focus();Feedback("连接配置需要调整，请检查行内提示。");return false;}
        foreach(string key in mediaKeys)if(!ValidateMediaField(key)) {Find<ListBox>("RuntimeNav").SelectedIndex=2;mediaInputs[key].BringIntoView();mediaInputs[key].Focus();Feedback("媒体模型配置需要调整，请检查行内提示。");return false;}
        if(SavedMediaEnabled()&&new[]{"visionModel","transcriptionModel","speechModel"}.Any(key=>((TextBox)fields["social."+key]).Text.Trim().Length>0)&&RuntimeValue("BOT_MEDIA_BASE_URL").Trim().Length==0) {
            runtimeErrors["BOT_MEDIA_BASE_URL"].Text="使用独立媒体模型前，请先填写媒体服务地址。";runtimeErrors["BOT_MEDIA_BASE_URL"].Visibility=Visibility.Visible;Find<ListBox>("RuntimeNav").SelectedIndex=2;runtimeInputs["BOT_MEDIA_BASE_URL"].BringIntoView();runtimeInputs["BOT_MEDIA_BASE_URL"].Focus();Feedback("请先配置媒体服务地址，再使用独立媒体模型。");return false;
        }
        return true;
    }
    static int RuntimeCategoryForKey(string key) {var card=runtimeInputs[key] as DependencyObject;while(card!=null){var element=card as FrameworkElement;if(element!=null&&runtimeCards.ContainsKey(element))return runtimeCards[element];card=System.Windows.Media.VisualTreeHelper.GetParent(card);}return 5;}
    static void SaveConnection(bool restart) {
        if(chatModelBusy)return;
        if(dirtySections.Contains("env")) {Find<ListBox>("RuntimeNav").SelectedIndex=5;Find<Expander>("AdvancedEnv").IsExpanded=true;Feedback("请先保存高级环境文件，再保存连接与媒体表单。");return;}
        if(RuntimeValue("BOT_SETTINGS_FILE")!=savedRuntimeValues["BOT_SETTINGS_FILE"]&&dirtySettingPaths.Any(path=>!IsMediaSetting(path))) {Feedback("请先保存机器人设置中的其他修改，再切换动态配置文件；媒体模型修改会保存到目标文件。");return;}
        foreach(string key in mediaKeys) {var text=fields["social."+key] as TextBox;if(text!=null)text.Text=text.Text.Trim();}
        if(!ValidateConnectionForm())return;
        var media=new Dictionary<string,object>();foreach(string key in mediaKeys) {Control input=fields["social."+key];media[key]=input is CheckBox?(object)(((CheckBox)input).IsChecked==true):key=="videoFrames"?(object)long.Parse(((TextBox)input).Text,CultureInfo.InvariantCulture):((TextBox)input).Text;}
        Send("connection",new {runtime=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key)),media=media,mediaPaths=dirtySettingPaths.Where(IsMediaSetting).Select(path=>path.Substring(7)).ToArray(),baseline=settings,sourceSettingsPath=settingsPath,restart=restart});
    }
    static void VerifyRuntimeInteraction() {
        if(Find<ListBox>("RuntimeNav").Items.Count!=6)throw new Exception("连接配置分类不完整");
        if(new[]{"ADMIN_QQ","GROUP_PREFIX","GROUP_COOLDOWN_MS","GROUP_CONTEXT_LINES","REPLY_CHUNK_SIZE","MIN_DELAY_MS","MAX_DELAY_MS","ALLOW_EXEC"}.Any(runtimeInputs.ContainsKey))throw new Exception("行为设置的环境默认值仍可重复编辑");
        var mode=(ComboBox)runtimeInputs["BOT_CHAT_MODE"];var model=(ComboBox)runtimeInputs["BOT_CHAT_MODEL"];var keyInput=(PasswordBox)runtimeInputs["QQ_BOT_DEEPSEEK_API_KEY"];
        string originalMode=RuntimeValue("BOT_CHAT_MODE"),originalModel=model.Text,originalKey=keyInput.Password;
        mode.SelectedValue="project";keyInput.Password="";
        if(!keyInput.IsEnabled||!chatModelTest.IsEnabled||ValidateRuntimeField("QQ_BOT_DEEPSEEK_API_KEY"))throw new Exception("项目模型输入状态异常：mode="+RuntimeValue("BOT_CHAT_MODE")+", keyEnabled="+keyInput.IsEnabled+", testEnabled="+chatModelTest.IsEnabled+", envDirty="+dirtySections.Contains("env"));
        keyInput.Password="native-fixture-key";model.Text="bad model";
        if(ValidateRuntimeField("BOT_CHAT_MODEL"))throw new Exception("模型 ID 接受了空白字符");
        model.Text="custom-fixture-model";model.ApplyTemplate();
        if(model.Template.FindName("PART_EditableTextBox",model)==null||!ValidateRuntimeField("BOT_CHAT_MODEL")||!ValidateRuntimeField("QQ_BOT_DEEPSEEK_API_KEY"))throw new Exception("模型名称无法手动输入");
        RenderChatModel(new Dictionary<string,object>{{"operation","list"},{"models",new[]{"custom-fixture-model","other-model"}},{"message","获取到两个测试模型。"}});
        if(model.Text!="custom-fixture-model"||model.Items.Count!=2)throw new Exception("模型列表覆盖了当前输入");
        SetChatModelBusy(true);if(chatModelTest.IsEnabled||keyInput.IsEnabled||Find<Button>("SaveRuntime").IsEnabled)throw new Exception("测试期间允许重复操作");SetChatModelBusy(false);
        Find<ListBox>("RuntimeNav").SelectedIndex=1;Capture(System.IO.Path.Combine(root,"model-project.png"),3);
        mode.SelectedValue="account";if(keyInput.IsEnabled||chatModelTest.IsEnabled||!model.IsEnabled)throw new Exception("账号模式没有隔离 API Key 控件");
        mode.SelectedValue=originalMode;model.Text=originalModel;keyInput.Password=originalKey;ValidateRuntimeField("BOT_CHAT_MODEL");ValidateRuntimeField("QQ_BOT_DEEPSEEK_API_KEY");
        var profile=(TextBox)runtimeInputs["BOT_DSH_PROFILE"];string originalProfile=profile.Text;
        profile.Text="bad profile";if(ValidateConnectionForm()||runtimeErrors["BOT_DSH_PROFILE"].Visibility!=Visibility.Visible||Find<ListBox>("RuntimeNav").SelectedIndex!=1)throw new Exception("Profile 校验没有定位到对话模型");
        if(!Find<TextBox>("Env").IsReadOnly||Find<Button>("SaveEnv").IsEnabled)throw new Exception("连接表单和高级文本可以同时编辑");
        profile.Text=originalProfile;ValidateRuntimeField("BOT_DSH_PROFILE");
        var vision=(TextBox)fields["social.visionModel"];string originalVision=vision.Text;var media=(TextBox)mediaInputs["visionModel"];
        if(!object.ReferenceEquals(media,vision)||mediaInputs.ContainsKey("mediaEnabled"))throw new Exception("媒体配置存在重复编辑器或重复功能开关");
        media.Text="vision-check";if(!dirtySections.Contains("models")||dirtySections.Contains("settings"))throw new Exception("媒体参数被归入机器人设置保存范围");vision.Text=originalVision;
        var frames=(TextBox)mediaInputs["videoFrames"];string originalFrames=frames.Text;frames.Text="0";
        if(ValidateConnectionForm()||mediaErrors["videoFrames"].Visibility!=Visibility.Visible||Find<ListBox>("RuntimeNav").SelectedIndex!=2)throw new Exception("媒体模型没有显示行内校验提示");frames.Text=originalFrames;ValidateMediaField("videoFrames");
        var saved=json.Deserialize<Dictionary<string,object>>(json.Serialize(settings));var disabled=json.Deserialize<Dictionary<string,object>>(json.Serialize(settings));((Dictionary<string,object>)disabled["social"])["mediaEnabled"]=false;
        ApplySavedSettings(disabled,new[]{"social.mediaEnabled"});if(!media.IsEnabled||!mediaSummary.Text.Contains("已关闭"))throw new Exception("关闭媒体能力后无法预先配置服务或缺少状态提示");ApplySavedSettings(saved,new[]{"social.mediaEnabled"});
        dirtySections.Remove("runtime");dirtySections.Remove("models");UpdateConnectionEditing();
        string originalEnv=Find<TextBox>("Env").Text;Find<TextBox>("Env").Text=originalEnv+"\n# preview";
        if(Find<StackPanel>("RuntimeFields").IsEnabled||Find<Button>("SaveRuntime").IsEnabled)throw new Exception("高级文本编辑未保护连接表单");
        Find<TextBox>("Env").Text=originalEnv;dirtySections.Remove("env");UpdateConnectionEditing();
        Find<TextBlock>("RuntimeHint").Text="仅保存本页连接与媒体参数；机器人设置另行保存。";
        for(int i=0;i<runtimeCategories.Length;i++){Find<ListBox>("RuntimeNav").SelectedIndex=i;Capture(System.IO.Path.Combine(root,"runtime-"+i+".png"),3);}
        double originalWidth=window.Width,originalHeight=window.Height;window.Width=1000;window.Height=700;window.UpdateLayout();
        Find<ListBox>("SettingsNav").SelectedIndex=5;Capture(System.IO.Path.Combine(root,"settings-compact.png"),2);
        if(Find<ListBox>("SettingsNav").ActualHeight>90||Find<ScrollViewer>("SettingsScroll").ActualWidth<700)throw new Exception("顶部设置导航没有释放内容宽度");
        Find<ListBox>("RuntimeNav").SelectedIndex=1;Capture(System.IO.Path.Combine(root,"model-compact.png"),3);
        window.Width=originalWidth;window.Height=originalHeight;Find<ListBox>("RuntimeNav").SelectedIndex=0;Find<ListBox>("SettingsNav").SelectedIndex=0;
    }
}
