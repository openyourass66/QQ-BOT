using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Diagnostics;

partial class App
{
    static bool quickSetupMode, quickReady, onboardingBusy;
    static int quickStep, quickRevision, checkedQuickRevision;
    static Dictionary<string,string> detectionBaseline = new Dictionary<string,string>();
    static readonly string[] quickTitles = { "1 检测环境", "2 选择模型", "3 连接 QQ", "4 检查并启动" };
    static readonly string[] quickDescriptions = {
        "先选择 QQ 接入方式，再检测 DSH 和 QQ 路径。已有 QQ 服务可跳过本机 NapCat 部署。",
        "已有 DSH 模型配置可直接沿用；首次使用建议选择本项目 API Key。Profile 和账号模式需先在 DSH 完成配置或登录。",
        "本机通常使用默认地址，只需核对 NapCat 的端口和令牌。机器人 QQ 可以自动识别，无需手填。",
        "检查当前输入后即可保存并启动。媒体、搜索、人设和行为参数可以稍后在全部设置中调整。"
    };
    static HashSet<string> QuickKeys() {
        var keys = quickStep==0 ? new[]{"BOT_ONEBOT_MODE","BOT_DSH_BIN","BOT_QQ_DIR"} : quickStep==1 ? new[]{"BOT_CHAT_MODE","BOT_CHAT_MODEL","QQ_BOT_DEEPSEEK_API_KEY","BOT_CHAT_BASE_URL"} : quickStep==2 ? new[]{"ONEBOT_HTTP_URL","ONEBOT_WS_URL","ONEBOT_TOKEN"} : new string[0];
        var result = new HashSet<string>(keys);
        if(runtimeInputs.ContainsKey("BOT_ONEBOT_MODE")&&RuntimeValue("BOT_ONEBOT_MODE")=="external")result.Remove("BOT_QQ_DIR");
        if(runtimeInputs.ContainsKey("BOT_CHAT_MODE")&&RuntimeValue("BOT_CHAT_MODE")=="profile") {result.Remove("BOT_CHAT_MODEL");result.Remove("QQ_BOT_DEEPSEEK_API_KEY");result.Remove("BOT_CHAT_BASE_URL");}
        else if(runtimeInputs.ContainsKey("BOT_CHAT_MODE")&&RuntimeValue("BOT_CHAT_MODE")=="account") {result.Remove("QQ_BOT_DEEPSEEK_API_KEY");result.Remove("BOT_CHAT_BASE_URL");}
        return result;
    }
    static void InitQuickSetup() {
        var steps=Find<WrapPanel>("QuickSteps");
        for(int i=0;i<quickTitles.Length;i++) {
            int step=i;var button=new Button {Content=quickTitles[i],Margin=new Thickness(0,0,8,8),Padding=new Thickness(11,8,11,8)};
            System.Windows.Automation.AutomationProperties.SetAutomationId(button,"QuickStep-"+i);
            button.Click+=(s,e)=>ShowQuickStep(step);steps.Children.Add(button);
        }
        Find<Button>("OpenQuickSetup").Click+=(s,e)=>OpenQuickSetup();
        Find<Button>("StartSetup").Click+=(s,e)=>OpenQuickSetup();
        Find<Button>("OpenAllSettings").Click+=(s,e)=>NavigateRuntime(RuntimePage);
        Find<Button>("QuickBack").Click+=(s,e)=>ShowQuickStep(Math.Max(0,quickStep-1));
        Find<Button>("QuickNext").Click+=(s,e)=>{
            foreach(string key in QuickKeys())if(!ValidateRuntimeField(key)){runtimeInputs[key].Focus();return;}
            ShowQuickStep(Math.Min(3,quickStep+1));
        };
        Find<Button>("DetectEnvironment").Click+=(s,e)=>RequestOnboarding("detect");
        Find<Button>("CheckSetup").Click+=(s,e)=>RequestOnboarding("check");
        Find<Button>("SetupGuide").Click+=(s,e)=>{
            ShowSetupGuide();
        };
    }
    static void OpenQuickSetup() {quickSetupMode=true;SelectedPage=MainPage.Runtime;ShowQuickStep(quickStep);}
    static void ShowQuickStep(int step) {
        quickStep=step;FilterRuntime();RefreshQuickSetup();Find<ScrollViewer>("RuntimeScroll").ScrollToTop();
        Find<TextBlock>("QuickNotice").Text=quickDescriptions[quickStep];
        Find<TextBlock>("RuntimeHint").Text=quickStep==3?"检查通过后可保存并启动；仅保存配置不会启动机器人。":"第 "+(quickStep+1)+" / 4 步 · 输入保留在草稿中，最后统一保存。";
        Find<TextBlock>("RuntimeTitle").Focusable=true;Find<TextBlock>("RuntimeTitle").Focus();
    }
    static void FilterQuickSetup() {
        Find<Border>("QuickSetupPanel").Visibility=quickSetupMode?Visibility.Visible:Visibility.Collapsed;
        Find<ListBox>("RuntimeNav").Visibility=quickSetupMode?Visibility.Collapsed:Visibility.Visible;
        Find<Border>("RuntimeCategoryBar").Visibility=quickSetupMode?Visibility.Collapsed:Visibility.Visible;
        var keys=QuickKeys();
        foreach(var badge in runtimeSaveBadges)badge.Visibility=quickSetupMode?Visibility.Collapsed:Visibility.Visible;
        var ordered=runtimeCardOrder.ToList();
        if(quickSetupMode&&quickStep==0)ordered=ordered.OrderBy(item=>{
            var element=item as FrameworkElement;if(element==null||!runtimeCardKeys.ContainsKey(element))return 4;
            var cardKeys=runtimeCardKeys[element];return cardKeys.Contains("BOT_ONEBOT_MODE")?0:cardKeys.Contains("BOT_DSH_BIN")?1:cardKeys.Contains("BOT_QQ_DIR")?2:3;
        }).ToList();
        var panel=Find<StackPanel>("RuntimeFields");
        for(int i=0;i<ordered.Count;i++)if(panel.Children.IndexOf(ordered[i])!=i){panel.Children.Remove(ordered[i]);panel.Children.Insert(i,ordered[i]);}
        foreach(var row in runtimeRows)row.Key.Visibility=!quickSetupMode||keys.Contains(row.Value)?Visibility.Visible:Visibility.Collapsed;
        if(chatModelActions!=null)chatModelActions.Visibility=quickSetupMode&&runtimeInputs.ContainsKey("BOT_CHAT_MODE")&&RuntimeValue("BOT_CHAT_MODE")!="project"?Visibility.Collapsed:Visibility.Visible;
        if(quickSetupMode) {
            foreach(var card in runtimeCards)card.Key.Visibility=runtimeCardKeys.ContainsKey(card.Key)&&runtimeCardKeys[card.Key].Any(keys.Contains)?Visibility.Visible:Visibility.Collapsed;
            Find<Expander>("AdvancedEnv").Visibility=Visibility.Collapsed;
            Find<TextBlock>("RuntimeTitle").Text="快速配置 · "+quickTitles[quickStep].Substring(2);
            Find<TextBlock>("RuntimeSubtitle").Text="使用默认参数完成基础连接，随时可切换到全部连接设置。";
        }
        RefreshQuickSetup();
    }
    static void RefreshQuickSetup() {
        bool editable=!onboardingBusy&&!chatModelBusy&&!runtimeBusy&&!dirtySections.Contains("env");
        Find<Button>("DetectEnvironment").IsEnabled=editable;
        Find<Button>("CheckSetup").IsEnabled=editable;
        Find<Button>("DetectEnvironment").Visibility=quickStep==0?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("CheckSetup").Visibility=quickStep==3?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SetupGuide").Visibility=quickStep==0||quickStep==3?Visibility.Visible:Visibility.Collapsed;
        Find<StackPanel>("QuickResults").Visibility=quickStep==3?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("QuickBack").Visibility=quickSetupMode&&quickStep>0?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("QuickNext").Visibility=quickSetupMode&&quickStep<3?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("QuickBack").IsEnabled=Find<Button>("QuickNext").IsEnabled=!onboardingBusy&&!chatModelBusy;
        Find<Button>("SaveRuntime").Visibility=Find<Button>("SaveRuntimeRestart").Visibility=!quickSetupMode||quickStep==3?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SaveRuntime").Content=quickSetupMode?"仅保存配置":"保存连接与媒体";
        Find<TextBlock>("RuntimeSaveScope").Text=quickSetupMode?"先完成基础连接，其余功能可以稍后设置。":"保存本页所有分类；机器人设置中的草稿另行保存。";
        Find<Button>("SaveRuntimeRestart").Content=quickSetupMode?"保存并启动":"保存并重新启动";
        Find<Button>("SaveRuntimeRestart").IsEnabled=editable&&(!quickSetupMode||quickReady);
        Find<Button>("SaveRuntime").IsEnabled=editable;
        foreach(Button button in Find<WrapPanel>("QuickSteps").Children) {
            int index=Find<WrapPanel>("QuickSteps").Children.IndexOf(button);button.Style=(Style)window.FindResource(index==quickStep?"Primary":"Quiet");
        }
        Find<Button>("OpenQuickSetup").Style=(Style)window.FindResource(quickSetupMode?"Primary":"Quiet");
        Find<Button>("OpenAllSettings").Style=(Style)window.FindResource(quickSetupMode?"Quiet":"Primary");
    }
    static void InvalidateQuickCheck() {
        quickRevision++;quickReady=false;Find<StackPanel>("QuickResults").Children.Clear();
        if(quickSetupMode&&quickStep==3)Find<TextBlock>("QuickNotice").Text="输入已修改，请重新检查后再保存并启动。";
        RefreshQuickSetup();
    }
    static void RequestOnboarding(string operation) {
        if(onboardingBusy||chatModelBusy||dirtySections.Contains("env")){Feedback("请先完成当前操作或保存高级环境文件。");return;}
        if(operation=="check"&&!ValidateConnectionForm())return;
        onboardingBusy=true;checkedQuickRevision=quickRevision;
        detectionBaseline=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key));
        Find<TextBlock>("QuickNotice").Text=operation=="detect"?"正在检测本机已安装程序，不会下载或安装组件…":"正在检查当前输入和 QQ HTTP 连接，不会调用对话模型或发送消息…";
        RefreshQuickSetup();Send("onboarding",new {operation=operation,runtime=detectionBaseline});
    }
    static void RenderOnboarding(Dictionary<string,object> message) {
        onboardingBusy=false;
        if((string)message["operation"]=="detect") {
            int applied=0;
            foreach(Dictionary<string,object> suggestion in (IEnumerable)message["suggestions"]) {
                string key=(string)suggestion["key"];
                if(!runtimeInputs.ContainsKey(key)||!detectionBaseline.ContainsKey(key)||RuntimeValue(key)!=detectionBaseline[key])continue;
                if(RuntimeValue(key).Length>0&&!(key=="BOT_DSH_BIN"&&RuntimeValue(key)=="dsh.cmd"))continue;
                ((TextBox)runtimeInputs[key]).Text=(string)suggestion["value"];applied++;
            }
            Find<TextBlock>("QuickNotice").Text=applied>0?"已补全 "+applied+" 个路径；请核对，保存后生效。":(string)message["message"];
        } else {
            quickReady=(bool)message["ok"]&&checkedQuickRevision==quickRevision;
            var panel=Find<StackPanel>("QuickResults");panel.Children.Clear();
            if(checkedQuickRevision==quickRevision)foreach(Dictionary<string,object> row in (IEnumerable)message["rows"])panel.Children.Add(DiagnosticCard(row,true));
            Find<TextBlock>("QuickNotice").Text=checkedQuickRevision!=quickRevision?"检查期间输入有变化，请重新检查。":(string)message["message"];
        }
        UpdateConnectionEditing();
    }
    static Border DiagnosticCard(Dictionary<string,object> row,bool quick) {
        bool ok=(bool)row["ok"],required=!row.ContainsKey("required")||(bool)row["required"];bool failure=!ok&&required;
        var body=new StackPanel();
        body.Children.Add(new TextBlock {Text=(ok?"通过":required?"需处理":"可跳过")+" · "+row["name"],FontWeight=FontWeights.SemiBold,Foreground=Ink(failure?"Danger":ok?"Success":"Muted")});
        body.Children.Add(new TextBlock {Text=(string)row["detail"],TextWrapping=TextWrapping.Wrap,Foreground=Ink("Muted"),FontSize=11,LineHeight=18,Margin=new Thickness(0,6,0,0)});
        string key=row.ContainsKey("key")?(string)row["key"]:"";
        if(failure&&runtimeInputs.ContainsKey(key)) {
            var fix=new Button {Content="去设置",Style=(Style)window.FindResource("Quiet"),HorizontalAlignment=HorizontalAlignment.Left,Margin=new Thickness(-8,6,0,0)};
            fix.Click+=(s,e)=>{if(quick&&new[]{"BOT_DSH_BIN","BOT_QQ_DIR","BOT_CHAT_MODE","ONEBOT_TOKEN","ONEBOT_HTTP_URL","ONEBOT_WS_URL"}.Contains(key)){quickSetupMode=true;ShowQuickStep(key=="BOT_CHAT_MODE"?1:key.StartsWith("ONEBOT_")?2:0);}else NavigateRuntime(RuntimeCategoryForKey(key));runtimeInputs[key].BringIntoView();runtimeInputs[key].Focus();};body.Children.Add(fix);
        }
        return new Border {Child=body,Background=Ink(failure?"AccentSoft":"Subtle"),Padding=new Thickness(14),CornerRadius=new CornerRadius(10),Margin=new Thickness(0,10,0,0)};
    }
    static Window CreateSetupGuide() {
        var guide=new Window {Title="组件安装指引",Owner=window,Width=640,Height=Math.Min(720,SystemParameters.WorkArea.Height-40),MinWidth=520,MinHeight=500,WindowStartupLocation=WindowStartupLocation.CenterOwner,Resources=window.Resources,Background=window.Background,Foreground=window.Foreground,FontFamily=window.FontFamily,FontSize=13};
        var content=new StackPanel {Margin=new Thickness(24)};
        content.Children.Add(new TextBlock {Text="准备好组件，再回来自动检测",FontSize=21,FontWeight=FontWeights.SemiBold,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,10)});
        content.Children.Add(new TextBlock {Text="程序只检查已安装的组件。下面的按钮打开官方说明，由你选择安装；现有账号与配置继续保留。",Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=21,Margin=new Thickness(0,0,0,20)});
        AddSetupGuideItem(content,"1 · 模型运行器 DSH","安装 DeepSeek Harness。返回后检测或选择安装目录中的 dsh.cmd；使用已有模型配置或账号登录时，请先在 DSH 完成相应配置。","打开 DSH 官方下载","https://deepseek.com/harness/");
        AddSetupGuideItem(content,"2 · QQ 与 NapCat","已有 NapCat 服务：先按官方说明启动并登录 QQ，再选择“连接已运行的 QQ 服务”。本机由工作台启动：需要 QQ、napcat/shell/napcat.mjs 及 napcat/node-runtime/QQNT.dll（官方 Node 适配库）。","打开 NapCat 官方安装说明","https://napneko.github.io/guide/boot/Shell","下载 QQ Windows 版","https://im.qq.com/pcqq/");
        AddSetupGuideItem(content,"3 · 核对两个连接地址","在 NapCat 网络设置启用 HTTP 服务（通常 3000）和正向 WebSocket 服务（通常 3001）。将对应地址及 access_token 填入本工作台；不要选择反向 WebSocket。","查看 NapCat 网络配置","https://napneko.github.io/config/basic");
        var close=new Button {Content="返回快速配置",Style=(Style)window.FindResource("Primary"),HorizontalAlignment=HorizontalAlignment.Right,Margin=new Thickness(0,12,0,0)};close.Click+=(s,e)=>guide.Close();content.Children.Add(close);
        guide.Content=new ScrollViewer {Content=content,Background=window.Background,VerticalScrollBarVisibility=ScrollBarVisibility.Auto};return guide;
    }
    static void AddSetupGuideItem(StackPanel content,string title,string detail,string label,string url,string extraLabel="",string extraUrl="") {
        content.Children.Add(new TextBlock {Text=title,FontSize=15,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,8)});
        content.Children.Add(new TextBlock {Text=detail,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=21});
        var links=new WrapPanel {Margin=new Thickness(0,10,0,14)};
        foreach(var link in extraUrl.Length>0?new[]{new[]{label,url},new[]{extraLabel,extraUrl}}:new[]{new[]{label,url}}) {
            string target=link[1];var button=new Button {Content=link[0],Margin=new Thickness(0,0,8,8)};
            button.Click+=(s,e)=>{try {Process.Start(new ProcessStartInfo(target) {UseShellExecute=true});}catch {Feedback("无法打开浏览器，请查看 docs/usage.md 中的官方链接。");}};links.Children.Add(button);
        }
        content.Children.Add(links);
    }
    static void ShowSetupGuide() {CreateSetupGuide().ShowDialog();}
    static void VerifyQuickSetupInteraction() {
        string original=RuntimeValue("BOT_DSH_BIN"),mode=RuntimeValue("BOT_CHAT_MODE"),key=RuntimeValue("QQ_BOT_DEEPSEEK_API_KEY");OpenQuickSetup();ShowQuickStep(0);Feedback("快速配置和全部设置共用草稿，切换页面不会丢失输入。");
        if(Find<ListBox>("RuntimeNav").Visibility!=Visibility.Collapsed||runtimeInputs["BOT_DSH_BIN"].IsVisible==false)throw new Exception("快速配置未显示基础环境");
        Capture(System.IO.Path.Combine(root,"quick-environment.png"),MainPage.Runtime);
        ShowQuickStep(1);Capture(System.IO.Path.Combine(root,"quick-profile.png"),MainPage.Runtime);
        ((ComboBox)runtimeInputs["BOT_CHAT_MODE"]).SelectedValue="project";((PasswordBox)runtimeInputs["QQ_BOT_DEEPSEEK_API_KEY"]).Password="native-setup-key";Capture(System.IO.Path.Combine(root,"quick-model.png"),MainPage.Runtime);
        ((ComboBox)runtimeInputs["BOT_CHAT_MODE"]).SelectedValue=mode;((PasswordBox)runtimeInputs["QQ_BOT_DEEPSEEK_API_KEY"]).Password=key;
        ShowQuickStep(3);quickReady=true;RefreshQuickSetup();
        ((TextBox)runtimeInputs["BOT_DSH_BIN"]).Text=original+"-changed";
        if(quickReady||Find<Button>("SaveRuntimeRestart").IsEnabled)throw new Exception("修改后未重新要求检查");
        ((TextBox)runtimeInputs["BOT_DSH_BIN"]).Text=original;
        checkedQuickRevision=quickRevision-1;RenderOnboarding(new Dictionary<string,object>{{"operation","check"},{"ok",true},{"rows",new object[0]},{"message","stale"}});
        if(quickReady)throw new Exception("过期检查结果允许了启动");
        detectionBaseline=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key));((TextBox)runtimeInputs["BOT_DSH_BIN"]).Text="user-selected.cmd";
        RenderOnboarding(new Dictionary<string,object>{{"operation","detect"},{"suggestions",new object[]{new Dictionary<string,object>{{"key","BOT_DSH_BIN"},{"value","detected.cmd"}}}},{"message","检测完成"}});
        if(RuntimeValue("BOT_DSH_BIN")!="user-selected.cmd")throw new Exception("自动检测覆盖了用户输入");((TextBox)runtimeInputs["BOT_DSH_BIN"]).Text=original;
        var rows=new object[]{new Dictionary<string,object>{{"name","DSH 启动入口"},{"ok",false},{"required",true},{"detail","请检测或选择已安装的 DSH 启动文件。"},{"key","BOT_DSH_BIN"}},new Dictionary<string,object>{{"name","NapCat Shell"},{"ok",false},{"required",false},{"detail","使用已有 QQ 服务，本机组件可跳过。"},{"key","BOT_NAPCAT_DIR"}}};
        checkedQuickRevision=quickRevision;RenderOnboarding(new Dictionary<string,object>{{"operation","check"},{"ok",false},{"rows",rows},{"message","请处理需处理的项目，再重新检查。"}});
        Capture(System.IO.Path.Combine(root,"quick-check.png"),MainPage.Runtime);
        double width=window.Width,height=window.Height;window.Width=1000;window.Height=720;Capture(System.IO.Path.Combine(root,"quick-compact.png"),MainPage.Runtime);window.Width=width;window.Height=height;
        var guide=CreateSetupGuide();guide.Show();guide.UpdateLayout();CaptureContent((FrameworkElement)guide.Content,System.IO.Path.Combine(root,"quick-guide.png"));guide.Close();
        NavigateRuntime(0);if(!Find<Button>("SaveRuntimeRestart").IsEnabled)throw new Exception("退出快速配置后无法保存全部设置");
        NavigateRuntime(4);OpenQuickSetup();Find<Button>("OpenAllSettings").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));window.UpdateLayout();
        if(SelectedPage!=MainPage.Runtime||Find<TextBlock>("RuntimeTitle").Text!="扩展服务"||!runtimeInputs["BOT_SEARCH_URL"].IsVisible||Find<Expander>("AdvancedEnv").Visibility!=Visibility.Collapsed)throw new Exception("退出快速配置后未返回原来的扩展服务分类");
        NavigateSetting("approval.adminQq");window.UpdateLayout();
        if(SelectedPage!=MainPage.Settings||Find<TextBlock>("PageTitle").Text!="机器人设置"||Find<TextBlock>("SettingsTitle").Text!="身份与审批"||!fields["approval.adminQq"].IsVisible)throw new Exception("跨页设置入口未定位到身份与审批");
        NavigateRuntime(0);Find<ListBox>("SettingsNav").SelectedIndex=0;
    }
}
