using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

partial class App
{
    static Window qqDialog;
    static TextBlock qqStatus,qqAccount;
    static Image qqImage;
    static TextBlock qqPlaceholder;
    static Button qqPrepare,qqRefresh,qqFill;
    static DispatcherTimer qqTimer;
    static bool qqBusy;
    static string qqPhase="setup_required";
    static Dictionary<string,string> qqBaseline=new Dictionary<string,string>();
    static void OpenQQLogin(bool preview=false) {
        if(qqDialog!=null){qqDialog.Activate();return;}
        qqDialog=new Window {Title="连接 QQ",Owner=window,Width=550,Height=Math.Min(670,SystemParameters.WorkArea.Height-30),MinWidth=480,MinHeight=500,WindowStartupLocation=WindowStartupLocation.CenterOwner,Resources=window.Resources,Background=window.Background,Foreground=window.Foreground,FontFamily=window.FontFamily,FontSize=13};
        var panel=new StackPanel();
        panel.Children.Add(new TextBlock {Text="登录你的机器人 QQ",FontSize=21,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,12)});
        panel.Children.Add(new TextBlock {Text="为已准备的 QQ 组件创建本机端口与随机令牌。使用手机 QQ 扫码并确认；已有手工配置请沿用高级连接。",TextWrapping=TextWrapping.Wrap,LineHeight=21,Margin=new Thickness(0,0,0,16)});
        var qr=new Grid {Width=256,Height=256,Background=Brushes.White,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(0,0,0,16)};
        qqImage=new Image {Width=256,Height=256,Stretch=Stretch.Uniform};qr.Children.Add(qqImage);
        qqPlaceholder=new TextBlock {Text="等待创建登录连接",TextAlignment=TextAlignment.Center,VerticalAlignment=VerticalAlignment.Center,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,Margin=new Thickness(20)};qr.Children.Add(qqPlaceholder);panel.Children.Add(qr);
        qqStatus=new TextBlock {Text="正在读取登录状态…",TextWrapping=TextWrapping.Wrap,LineHeight=21,Margin=new Thickness(0,0,0,8)};
        System.Windows.Automation.AutomationProperties.SetAutomationId(qqStatus,"QQLoginStatus");panel.Children.Add(qqStatus);
        qqAccount=new TextBlock {Foreground=Ink("Muted"),Margin=new Thickness(0,0,0,16)};panel.Children.Add(qqAccount);
        var actions=new WrapPanel();panel.Children.Add(actions);
        qqPrepare=new Button {Content="自动配置并启动 QQ",Margin=new Thickness(0,0,8,8)};qqPrepare.Click+=(s,e)=>RequestQQLogin("prepare");actions.Children.Add(qqPrepare);
        qqRefresh=new Button {Content="刷新二维码",Margin=new Thickness(0,0,8,8)};qqRefresh.Click+=(s,e)=>RequestQQLogin("refresh");actions.Children.Add(qqRefresh);
        qqFill=new Button {Content="填入连接草稿",Margin=new Thickness(0,0,0,8)};qqFill.Click+=(s,e)=>RequestQQLogin("connection");actions.Children.Add(qqFill);
        panel.Children.Add(new TextBlock {Text="关闭本窗口后 QQ 继续运行。连接草稿需保存后生效；停止 QQ 请使用工作台的停止按钮。",Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=20,Margin=new Thickness(0,8,0,0)});
        qqDialog.Content=new Border {Padding=new Thickness(24),Background=window.Background,Child=new ScrollViewer {Content=panel,VerticalScrollBarVisibility=ScrollBarVisibility.Auto}};
        qqDialog.Closed+=(s,e)=>{if(qqTimer!=null)qqTimer.Stop();qqImage.Source=null;qqDialog=null;};
        qqBusy=false;qqPhase="setup_required";UpdateQQActions();
        if(preview){qqDialog.Show();return;}
        qqTimer=new DispatcherTimer {Interval=TimeSpan.FromSeconds(3)};qqTimer.Tick+=(s,e)=>{if(!qqBusy&&qqDialog!=null)RequestQQLogin("status");};qqTimer.Start();
        RequestQQLogin("status");qqDialog.ShowDialog();
    }
    static void UpdateQQActions() {
        if(qqDialog==null)return;
        qqPrepare.IsEnabled=!qqBusy&&(qqPhase=="setup_required"||qqPhase=="needs_attention");
        qqRefresh.IsEnabled=!qqBusy&&qqPhase!="setup_required"&&qqPhase!="ready"&&qqPhase!="starting";
        qqFill.IsEnabled=!qqBusy&&qqPhase!="setup_required";
    }
    static void RequestQQLogin(string operation) {
        if(qqBusy)return;
        if(operation!="status")qqBaseline=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key));
        qqBusy=true;UpdateQQActions();
        if(operation=="prepare")qqStatus.Text="正在创建安全连接并启动 QQ，请稍候…";
        Send("qq-login",new {operation=operation,shell=RuntimeValue("BOT_NAPCAT_DIR"),mode=RuntimeValue("BOT_ONEBOT_MODE")});
    }
    static void RenderQQLogin(Dictionary<string,object> message) {
        qqBusy=false;if(qqDialog==null)return;
        if(message.ContainsKey("suggestions")) {
            var suggestions=(Dictionary<string,object>)message["suggestions"];
            bool unchanged=suggestions.Keys.All(key=>runtimeInputs.ContainsKey(key)&&qqBaseline.ContainsKey(key)&&RuntimeValue(key)==qqBaseline[key]);
            if(unchanged)foreach(var item in suggestions) {
                var input=runtimeInputs[item.Key];var password=input as PasswordBox;var combo=input as ComboBox;
                if(password!=null)password.Password=(string)item.Value;else if(combo!=null)combo.SelectedValue=(string)item.Value;else ((TextBox)input).Text=(string)item.Value;
            }
            qqStatus.Text=unchanged?"本机安全连接已填入草稿，关闭后请检查并保存。":"连接已准备；当前草稿有新修改，未覆盖。可再次点击填入连接草稿。";
        }
        if(message.ContainsKey("phase")) {
            qqPhase=(string)message["phase"];if(message.ContainsKey("message"))qqStatus.Text=(string)message["message"];
            qqAccount.Text=message.ContainsKey("account")?"当前 QQ："+message["account"]:"";
            qqImage.Source=null;qqPlaceholder.Visibility=Visibility.Visible;
            qqPlaceholder.Text=qqPhase=="ready"?"QQ 已登录":qqPhase=="qrcode_scanned"?"请在手机上确认":qqPhase=="needs_attention"?"需要处理登录状态":qqPhase=="setup_required"?"等待创建登录连接":"正在连接 QQ…";
            if(message.ContainsKey("qrImage")) {
                string data=message["qrImage"] as string;
                if(data!=null&&data.StartsWith("data:image/png;base64,")&&data.Length<131072) {
                    using(var stream=new MemoryStream(Convert.FromBase64String(data.Substring(22)))) {var bitmap=new BitmapImage();bitmap.BeginInit();bitmap.CacheOption=BitmapCacheOption.OnLoad;bitmap.StreamSource=stream;bitmap.EndInit();bitmap.Freeze();qqImage.Source=bitmap;}
                    qqPlaceholder.Visibility=Visibility.Collapsed;
                }
            }
        }
        UpdateQQActions();
    }
    static void QQLoginError(string text) {qqBusy=false;if(qqDialog==null)return;qqPhase="needs_attention";qqStatus.Text=text;qqImage.Source=null;qqPlaceholder.Visibility=Visibility.Visible;qqPlaceholder.Text="操作未完成";UpdateQQActions();}
    static void VerifyQQLoginInteraction() {
        OpenQQLogin(true);RenderQQLogin(new Dictionary<string,object>{{"phase","setup_required"},{"message","点击自动配置并启动 QQ，开始登录。"}});
        if(!qqPrepare.IsEnabled||qqRefresh.IsEnabled)throw new Exception("QQ login initial actions are incorrect");
        string fixture=Path.Combine(root,"qq-login-qr.txt");
        if(File.Exists(fixture)) {
            RenderQQLogin(new Dictionary<string,object>{{"phase","waiting_qrcode"},{"message","扫码界面示例，非真实登录二维码。"},{"qrImage",File.ReadAllText(fixture)}});
            if(qqImage.Source==null||qqPlaceholder.Visibility!=Visibility.Collapsed)throw new Exception("QR image failed to render");
            qqDialog.UpdateLayout();CaptureContent((FrameworkElement)qqDialog.Content,Path.Combine(root,"qq-login-qr.png"));
        }
        RenderQQLogin(new Dictionary<string,object>{{"phase","qrcode_scanned"},{"message","已扫码，请在手机 QQ 确认。"}});
        if(qqImage.Source!=null||qqPlaceholder.Visibility!=Visibility.Visible||qqPrepare.IsEnabled)throw new Exception("Scanned QR was not cleared");
        RenderQQLogin(new Dictionary<string,object>{{"phase","ready"},{"message","QQ 已登录，本机安全连接已配置。请保存草稿并检查启动。"},{"account","10001"}});
        if(qqRefresh.IsEnabled||!qqFill.IsEnabled||!qqAccount.Text.Contains("10001"))throw new Exception("QQ ready state is incorrect");
        qqDialog.UpdateLayout();CaptureContent((FrameworkElement)qqDialog.Content,Path.Combine(root,"qq-login-ready.png"));
        qqDialog.Width=480;qqDialog.Height=500;QQLoginError("QQ 需要额外验证，请按官方流程处理后重试。");qqDialog.UpdateLayout();
        if(!qqPrepare.IsEnabled||qqImage.Source!=null)throw new Exception("QQ error recovery is incorrect");
        CaptureContent((FrameworkElement)qqDialog.Content,Path.Combine(root,"qq-login-attention.png"));qqDialog.Close();
    }
}
