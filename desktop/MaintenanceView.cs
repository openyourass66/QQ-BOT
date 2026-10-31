using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;

partial class App
{
    static Window maintenanceDialog;
    static TextBlock maintenanceStatus;
    static PasswordBox maintenancePassword,maintenanceConfirmation;
    static ProgressBar maintenanceProgress;
    static Button maintenanceCancel,maintenanceRecover;
    static Button maintenanceDelete;
    static TextBox maintenanceRetention;
    static ScrollViewer maintenanceContent;
    static int maintenancePreviewDays,maintenanceEligible;
    static readonly List<Button> maintenanceActions=new List<Button>();
    static bool maintenanceBusy,recoveryPending,upgradePending;
    static string maintenanceRemotePath,maintenanceDownloadLocal;
    static Button maintenanceInstaller;
    static TextBlock maintenanceModeNote;

    static void BuildMaintenanceCard(StackPanel panel) {
        var body=new StackPanel();var button=new Button {Content="数据备份与恢复",HorizontalAlignment=HorizontalAlignment.Left,MinHeight=36,Margin=new Thickness(0,8,0,10)};
        System.Windows.Automation.AutomationProperties.SetAutomationId(button,"OpenMaintenance");button.Click+=(s,e)=>OpenMaintenance();body.Children.Add(button);
        body.Children.Add(new TextBlock {Text="停止机器人后备份、恢复、预览清理媒体，或导出可分享的脱敏诊断。",TextWrapping=TextWrapping.Wrap,Foreground=Ink("Muted"),LineHeight=20});
        panel.Children.Add(RuntimeCard("数据维护","备份包含四类存储、配置、人设、记忆、媒体及受管密钥文件。",body,5));
    }
    static void OpenMaintenance(bool preview=false) {
        if(maintenanceDialog!=null){maintenanceDialog.Activate();return;}
        if(!preview&&dirty){Feedback("请先保存或放弃未保存的编辑，再打开数据维护。");return;}
        maintenanceDialog=new Window {Title="数据备份与恢复",Owner=window,Width=560,Height=Math.Min(680,SystemParameters.WorkArea.Height-30),MinWidth=480,MinHeight=500,WindowStartupLocation=WindowStartupLocation.CenterOwner,Resources=window.Resources,Background=window.Background,Foreground=window.Foreground,FontFamily=window.FontFamily,FontSize=13};
        var body=new StackPanel();body.Children.Add(new TextBlock {Text="保留一份可恢复的数据",FontSize=22,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,12)});
        body.Children.Add(new TextBlock {Text="请先停止机器人和受管 QQ。备份使用密码加密；忘记密码无法恢复。QQ / 模型账号登录状态不包含在备份中。",TextWrapping=TextWrapping.Wrap,LineHeight=21,Margin=new Thickness(0,0,0,16)});
        body.Children.Add(new TextBlock {Text="备份密码（12–512 个字符）",Margin=new Thickness(0,0,0,5)});
        maintenancePassword=new PasswordBox {MaxLength=512,MinHeight=34,Margin=new Thickness(0,0,0,12)};System.Windows.Automation.AutomationProperties.SetName(maintenancePassword,"备份密码");body.Children.Add(maintenancePassword);
        body.Children.Add(new TextBlock {Text="再次输入密码（创建备份时填写）",Margin=new Thickness(0,0,0,5)});
        maintenanceConfirmation=new PasswordBox {MaxLength=512,MinHeight=34,Margin=new Thickness(0,0,0,16)};System.Windows.Automation.AutomationProperties.SetName(maintenanceConfirmation,"确认备份密码");body.Children.Add(maintenanceConfirmation);
        var actions=new WrapPanel();maintenanceActions.Clear();foreach(var pair in new[]{new[]{"创建加密备份","backup"},new[]{"校验备份","verify"},new[]{"恢复备份","restore"},new[]{"从其它设备迁移","migrate"}}){string operation=pair[1];var button=new Button {Content=pair[0],MinHeight=36,Margin=new Thickness(0,0,10,10)};button.Click+=(s,e)=>RequestMaintenance(operation);actions.Children.Add(button);maintenanceActions.Add(button);}body.Children.Add(actions);
        body.Children.Add(new TextBlock {Text="恢复仅支持原实例与相同数据路径；迁移到服务器或其它数据目录请使用“从其它设备迁移”。两者都会先保存当前数据恢复点，失败会尝试撤回。迁移后模型密钥等凭据需重新录入，QQ 也需重新扫码登录。请保持程序打开。",TextWrapping=TextWrapping.Wrap,LineHeight=20,Foreground=Ink("Muted"),Margin=new Thickness(0,3,0,16)});
        body.Children.Add(new TextBlock {Text="清理无引用媒体",FontSize=16,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,5,0,8)});
        body.Children.Add(new TextBlock {Text="只清理超过保留期的受管缓存，保护收藏、待执行任务、未知动作和用户文件。已删除文件不能撤回。",TextWrapping=TextWrapping.Wrap,LineHeight=20,Foreground=Ink("Muted"),Margin=new Thickness(0,0,0,8)});
        var retention=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(0,0,0,10)};retention.Children.Add(new TextBlock {Text="保留天数",VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(0,0,10,0)});maintenanceRetention=new TextBox {Text="30",Width=80,MinHeight=34,MaxLength=4};System.Windows.Automation.AutomationProperties.SetName(maintenanceRetention,"媒体保留天数");retention.Children.Add(maintenanceRetention);body.Children.Add(retention);
        var cleanupActions=new WrapPanel();foreach(var pair in new[]{new[]{"预览媒体清理","cleanup-preview"},new[]{"清理预览中的缓存","cleanup"},new[]{"导出脱敏诊断","diagnostic"}}){string operation=pair[1];var button=new Button {Content=pair[0],MinHeight=36,Margin=new Thickness(0,0,10,10)};button.Click+=(s,e)=>RequestMaintenance(operation);cleanupActions.Children.Add(button);maintenanceActions.Add(button);if(operation=="cleanup")maintenanceDelete=button;}body.Children.Add(cleanupActions);
        maintenancePreviewDays=0;maintenanceEligible=0;maintenanceDelete.IsEnabled=false;maintenanceRetention.TextChanged+=(s,e)=>{maintenancePreviewDays=0;maintenanceEligible=0;maintenanceDelete.IsEnabled=false;};
        body.Children.Add(new TextBlock {Text="脱敏诊断不需要备份密码，只含版本、配置状态和数据库检查结果，不含聊天、提示词、日志正文、路径或密钥。",TextWrapping=TextWrapping.Wrap,LineHeight=20,Foreground=Ink("Muted"),Margin=new Thickness(0,0,0,14)});
        var installer=new Button {Content="安装、升级与回退",HorizontalAlignment=HorizontalAlignment.Left,MinHeight=36,Margin=new Thickness(0,0,0,12)};installer.Click+=(s,e)=>OpenInstaller();body.Children.Add(installer);maintenanceActions.Add(installer);maintenanceInstaller=installer;
        maintenanceModeNote=new TextBlock {Text="",TextWrapping=TextWrapping.Wrap,LineHeight=20,Foreground=Ink("Muted"),Margin=new Thickness(0,0,0,12),Visibility=Visibility.Collapsed};body.Children.Add(maintenanceModeNote);
        maintenanceRecover=new Button {Content="处理上次中断",HorizontalAlignment=HorizontalAlignment.Left,MinHeight=34,Margin=new Thickness(0,0,0,12),Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed};maintenanceRecover.Click+=(s,e)=>RequestMaintenance("recover");body.Children.Add(maintenanceRecover);
        maintenanceProgress=new ProgressBar {Height=5,IsIndeterminate=true,Visibility=Visibility.Collapsed,Margin=new Thickness(0,0,0,12)};body.Children.Add(maintenanceProgress);
        maintenanceStatus=new TextBlock {Text="请选择操作。备份包含私人数据，请妥善保管。",TextWrapping=TextWrapping.Wrap,LineHeight=21,MinHeight=50,Margin=new Thickness(0,0,0,12)};System.Windows.Automation.AutomationProperties.SetName(maintenanceStatus,"维护结果");body.Children.Add(maintenanceStatus);
        var footer=new WrapPanel();maintenanceCancel=new Button {Content="取消操作",IsEnabled=false,Margin=new Thickness(0,0,10,0),MinHeight=34};maintenanceCancel.Click+=(s,e)=>{maintenanceCancel.IsEnabled=false;maintenanceStatus.Text=CancelRemoteTransfer()?"正在取消文件传输…":"正在取消，等待保留或撤回未完成操作…";Send("maintenance-cancel");};footer.Children.Add(maintenanceCancel);var close=new Button {Content="关闭",MinHeight=34};close.Click+=(s,e)=>maintenanceDialog.Close();footer.Children.Add(close);body.Children.Add(footer);
        body.Children.Remove(maintenanceProgress);body.Children.Remove(maintenanceStatus);body.Children.Remove(footer);
        body.Children.Remove(maintenanceRecover);maintenanceRecover.Margin=new Thickness(0,0,10,0);footer.Children.Insert(0,maintenanceRecover);
        var statusPanel=new StackPanel();statusPanel.Children.Add(maintenanceProgress);statusPanel.Children.Add(maintenanceStatus);
        var fixedStatus=new ScrollViewer {Content=statusPanel,MaxHeight=140,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Margin=new Thickness(0,10,0,8)};
        var dock=new DockPanel();DockPanel.SetDock(footer,Dock.Bottom);dock.Children.Add(footer);DockPanel.SetDock(fixedStatus,Dock.Bottom);dock.Children.Add(fixedStatus);maintenanceContent=new ScrollViewer {Content=body,VerticalScrollBarVisibility=ScrollBarVisibility.Auto};dock.Children.Add(maintenanceContent);
        maintenanceDialog.Content=new Border {Padding=new Thickness(24),Background=window.Background,Child=dock};
        maintenanceDialog.Closing+=(s,e)=>{if(maintenanceBusy){e.Cancel=true;maintenanceStatus.Text="维护正在进行，请先取消并等待完成。";return;}maintenancePassword.Clear();maintenanceConfirmation.Clear();};maintenanceDialog.Closed+=(s,e)=>{maintenanceDialog=null;maintenanceActions.Clear();};
        RefreshMaintenanceMode();
        if(preview){maintenanceDialog.Show();return;}Send("maintenance",new {operation="status"});maintenanceDialog.ShowDialog();
    }
    static void RefreshMaintenanceMode() {
        bool remote=RemoteModeActive();
        if(maintenanceInstaller!=null)maintenanceInstaller.Visibility=remote?Visibility.Collapsed:Visibility.Visible;
        if(maintenanceModeNote!=null){
            maintenanceModeNote.Text=remote?"远程模式：备份与脱敏诊断在服务器上生成后下载到你选择的本机位置；恢复、迁移与校验会先把备份上传到服务器暂存目录。安装、升级与回退请在服务器上执行。":"";
            maintenanceModeNote.Visibility=remote?Visibility.Visible:Visibility.Collapsed;
        }
    }
    static void SetMaintenanceBusy(bool value) {maintenanceBusy=value;if(maintenanceDialog==null)return;foreach(var button in maintenanceActions)button.IsEnabled=!value;maintenanceDelete.IsEnabled=!value&&maintenancePreviewDays>0&&maintenanceEligible>0;maintenanceRetention.IsEnabled=!value;maintenancePassword.IsEnabled=!value;maintenanceConfirmation.IsEnabled=!value;maintenanceRecover.IsEnabled=!value;maintenanceCancel.IsEnabled=value;maintenanceProgress.Visibility=value?Visibility.Visible:Visibility.Collapsed;}
    static void RequestMaintenance(string operation) {
        if(maintenanceBusy)return;
        bool remote=RemoteModeActive();var profile=remote?ActiveRemoteProfile():null;
        if(remote&&profile==null){maintenanceStatus.Text="服务器连接配置不可用，请重新连接后再操作。";return;}
        if(operation=="diagnostic"){var picker=new Microsoft.Win32.SaveFileDialog {Title="保存可分享脱敏诊断",Filter="小鲸脱敏诊断|*.wwdiagnostic.json",DefaultExt=".wwdiagnostic.json",FileName="小鲸诊断-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+".wwdiagnostic.json"};if(picker.ShowDialog(maintenanceDialog)!=true)return;if(remote){maintenanceDownloadLocal=picker.FileName;SetMaintenanceBusy(true);maintenanceStatus.Text="正在服务器上生成脱敏诊断…";Send("maintenance",new {operation=operation,file=RemoteTempPath("whale-diagnostic",".wwdiagnostic.json")});return;}SetMaintenanceBusy(true);maintenanceStatus.Text="正在导出脱敏诊断…";Send("maintenance",new {operation=operation,file=picker.FileName});return;}
        if(operation=="cleanup-preview"||operation=="cleanup"){int days;if(!Int32.TryParse(maintenanceRetention.Text,out days)||days<1||days>3650){maintenanceStatus.Text="保留天数须为 1–3650 的整数。";maintenanceRetention.Focus();return;}if(operation=="cleanup"&&(maintenancePreviewDays!=days||maintenanceEligible<=0)){maintenanceStatus.Text="请先预览当前保留期的媒体清理结果。";return;}if(operation=="cleanup"&&MessageBox.Show(maintenanceDialog,"预览发现 "+maintenanceEligible+" 个候选缓存。仅清理超过 "+days+" 天且仍无引用的受管文件；每个文件会再次核验。已删除文件不能撤回，是否继续？","确认媒体清理",MessageBoxButton.YesNo,MessageBoxImage.Warning)!=MessageBoxResult.Yes)return;maintenancePreviewDays=0;maintenanceEligible=0;SetMaintenanceBusy(true);maintenanceStatus.Text=operation=="cleanup"?"正在清理媒体，可取消剩余操作…":"正在核对媒体与引用…";Send("maintenance",new {operation=operation,retentionDays=days});return;}
        if(operation=="recover"){if(MessageBox.Show(maintenanceDialog,"处理上次恢复中断，可能撤回尚未完成的数据切换。是否继续？","处理恢复中断",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;SetMaintenanceBusy(true);Send("maintenance",new {operation=operation});return;}
        string password=maintenancePassword.Password;if(password.Length<12){maintenanceStatus.Text="请输入至少 12 个字符的备份密码。";maintenancePassword.Focus();return;}if(operation=="backup"&&password!=maintenanceConfirmation.Password){maintenanceStatus.Text="两次输入的密码不一致。";maintenanceConfirmation.Focus();return;}
        if(operation=="backup"){var picker=new Microsoft.Win32.SaveFileDialog {Title="保存加密备份",Filter="小鲸加密备份|*.wwbackup",DefaultExt=".wwbackup",FileName="小鲸备份-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+".wwbackup"};if(picker.ShowDialog(maintenanceDialog)!=true)return;if(remote){maintenanceDownloadLocal=picker.FileName;SetMaintenanceBusy(true);maintenanceStatus.Text="正在服务器上准备加密备份…";Send("maintenance",new {operation=operation,file=RemoteStagingDirectory(profile)+"/"+RemoteFileName("whale-backup",".wwbackup"),password=password});return;}SetMaintenanceBusy(true);maintenanceStatus.Text="正在准备加密备份…";Send("maintenance",new {operation=operation,file=picker.FileName,password=password});return;}
        var backupPicker=new Microsoft.Win32.OpenFileDialog {Title=operation=="verify"?"选择要校验的备份":operation=="migrate"?"选择要迁移到本机的备份":"选择要恢复的备份",Filter="小鲸加密备份|*.wwbackup"};if(backupPicker.ShowDialog(maintenanceDialog)!=true)return;string localFile=backupPicker.FileName;
        if(operation=="restore"&&MessageBox.Show(maintenanceDialog,"恢复将替换当前实例的配置、聊天记录、人设、记忆和媒体。程序会先创建当前数据的加密恢复点。确认恢复此备份？","恢复数据",MessageBoxButton.YesNo,MessageBoxImage.Warning)!=MessageBoxResult.Yes)return;
        if(operation=="migrate"&&MessageBox.Show(maintenanceDialog,"迁移会用备份内容替换当前实例的配置、聊天记录、人设、记忆和媒体，并先创建当前数据的加密恢复点。目标设备需要重新准备运行组件；模型密钥等凭据需要重新录入；QQ 也需要重新扫码登录。确认迁移此备份？","从其它设备迁移",MessageBoxButton.YesNo,MessageBoxImage.Warning)!=MessageBoxResult.Yes)return;
        if(remote){string directory=RemoteStagingDirectory(profile);string error;if(!EnsureRemoteDirectory(profile,directory,out error)){maintenanceStatus.Text="无法准备服务器暂存目录："+error;return;}string remoteFile=directory+"/"+RemoteFileName(operation,".wwbackup");maintenanceRemotePath=remoteFile;SetMaintenanceBusy(true);maintenanceStatus.Text="正在上传备份到服务器…";BeginRemoteTransfer(profile,true,localFile,remoteFile,(ok,message)=>{if(!ok){maintenanceRemotePath=null;MaintenanceError("上传备份失败："+message);return;}maintenanceStatus.Text=operation=="restore"?"正在服务器上检查并恢复备份…":operation=="migrate"?"正在服务器上检查并迁移备份…":"正在服务器上校验备份…";Send("maintenance",new {operation=operation,file=remoteFile,password=password});});return;}
        maintenanceStatus.Text="正在检查备份…";SetMaintenanceBusy(true);Send("maintenance",new {operation=operation,file=localFile,password=password});
    }
    static void RenderMaintenance(Dictionary<string,object> message) {
        string operation=Convert.ToString(message["operation"]);
        if(operation=="status"){recoveryPending=message.ContainsKey("recoveryPending")&&(bool)message["recoveryPending"];upgradePending=message.ContainsKey("recoveryKind")&&Convert.ToString(message["recoveryKind"])=="upgrade";if(maintenanceDialog!=null){maintenanceRecover.Visibility=recoveryPending&&!upgradePending?Visibility.Visible:Visibility.Collapsed;if(recoveryPending)maintenanceStatus.Text=upgradePending?"上次升级尚未收尾，请选择“安装、升级与回退”，在工具中处理上次中断。":"上次恢复尚未收尾，请先点击“处理上次中断”。";}return;}
        if(operation=="restore"||operation=="migrate"||operation=="recover"){recoveryPending=false;maintenancePreviewDays=0;maintenanceEligible=0;}
        if(operation=="cleanup-preview"){maintenancePreviewDays=Convert.ToInt32(message["retentionDays"]);maintenanceEligible=Convert.ToInt32(message["eligible"]);}
        bool remote=RemoteModeActive();
        if(remote&&(operation=="backup"||operation=="diagnostic")){
            string serverFile=message.ContainsKey("file")?Convert.ToString(message["file"]):"";
            string local=maintenanceDownloadLocal;maintenanceDownloadLocal=null;
            if(string.IsNullOrEmpty(local)||!ValidTransferPath(serverFile)){MaintenanceError("服务器已生成文件，但未能确定本机保存位置："+serverFile);return;}
            var profile=ActiveRemoteProfile();maintenanceStatus.Text="服务器已生成文件，正在下载到本机…";
            BeginRemoteTransfer(profile,false,local,serverFile,(ok,text)=>{
                if(ok)DeleteRemoteFileQuiet(profile,serverFile);
                SetMaintenanceBusy(false);if(maintenanceDialog==null)return;maintenancePassword.Clear();maintenanceConfirmation.Clear();maintenanceRecover.Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed;
                maintenanceStatus.Text=ok?(operation=="backup"?"加密备份已下载到本机：\n"+local+"\n服务器暂存文件已清理。":"脱敏诊断已保存，可分享此文件：\n"+local+"\n服务器暂存文件已清理。"):"服务器文件已保留："+serverFile+"\n下载失败："+text;
            });
            return;
        }
        if(remote&&(operation=="verify"||operation=="restore"||operation=="migrate")&&maintenanceRemotePath!=null){DeleteRemoteFileQuiet(ActiveRemoteProfile(),maintenanceRemotePath);maintenanceRemotePath=null;}
        SetMaintenanceBusy(false);if(maintenanceDialog!=null){maintenancePassword.Clear();maintenanceConfirmation.Clear();maintenanceRecover.Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed;maintenanceStatus.Text=operation=="diagnostic"?"脱敏诊断已保存，可分享此文件：\n"+Convert.ToString(message["file"]):operation.StartsWith("cleanup")?(operation=="cleanup-preview"?"预览完成：候选 "+message["eligible"]+" 个":"已删除 "+message["deleted"]+" 个，释放 "+Math.Round(Convert.ToDouble(message["bytes"])/1048576,2)+" MiB")+"，引用保护 "+message["protected"]+" 个。"+((bool)message["complete"]?" 本次检查完成。":" 本次达到数量或时间上限，可再次预览继续。") :operation=="backup"?"加密备份已保存：\n"+Convert.ToString(message["file"]):operation=="verify"?"备份校验通过，共 "+message["files"]+" 个文件。":operation=="restore"?"数据已恢复。切换前的加密恢复点：\n"+Convert.ToString(message["recoveryPoint"]):operation=="migrate"?"数据已迁移。切换前的加密恢复点：\n"+Convert.ToString(message["recoveryPoint"])+"\n请重新准备运行组件、重新录入模型密钥等凭据，并在「QQ 登录」窗口重新扫码。":"中断处理完成，可以重新检查并启动机器人。";}
        if(operation=="restore"||operation=="migrate"||operation=="recover"){Send("load");Send("diagnose");}
    }
    static void RenderMaintenanceProgress(Dictionary<string,object> message) {if(maintenanceDialog==null)return;var labels=new Dictionary<string,string>{{"reading","正在读取并加密数据"},{"verifying","正在解密并校验文件"},{"recovery-point","正在保存当前数据恢复点"},{"switching","正在切换数据，取消时将尝试撤回"},{"diagnostic","正在检查并生成脱敏诊断"},{"cleanup","正在核对媒体与引用"},{"complete","维护已完成"}};string stage=Convert.ToString(message["stage"]);maintenanceStatus.Text=(labels.ContainsKey(stage)?labels[stage]:"正在维护数据")+"\n已处理 "+message["files"]+" 个文件";}
    static void MaintenanceError(string text) {CancelRemoteTransfer();if(maintenanceRemotePath!=null){DeleteRemoteFileQuiet(ActiveRemoteProfile(),maintenanceRemotePath);maintenanceRemotePath=null;}maintenanceDownloadLocal=null;SetMaintenanceBusy(false);if(maintenanceDialog!=null){maintenancePassword.Clear();maintenanceConfirmation.Clear();maintenanceStatus.Text=text;maintenanceRecover.Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed;}}
    static void MaintenanceSmoke() {
        OpenMaintenance(true);SetMaintenanceBusy(true);if(maintenanceActions[0].IsEnabled||!maintenanceCancel.IsEnabled)throw new Exception("Maintenance controls are not protected");
        var activeHost=host;try{host=null;Send("maintenance",new {operation="status"});}finally{host=activeHost;}if(maintenanceBusy||!maintenanceActions[0].IsEnabled)throw new Exception("Maintenance dialog cannot recover from a lost host");SetMaintenanceBusy(true);
        if(maintenanceDelete.IsEnabled||maintenanceRetention.IsEnabled)throw new Exception("Media maintenance is not protected");SetMaintenanceBusy(false);maintenancePreviewDays=30;maintenanceEligible=1;SetMaintenanceBusy(false);if(!maintenanceDelete.IsEnabled)throw new Exception("Media preview cannot be confirmed");maintenanceRetention.Text="31";if(maintenanceDelete.IsEnabled)throw new Exception("Changed retention must invalidate preview");maintenanceRetention.Text="30";
        recoveryPending=true;MaintenanceError("测试：恢复中断，原数据保留。请处理上次中断后再启动。");maintenanceDialog.Width=480;maintenanceDialog.Height=540;maintenanceDialog.UpdateLayout();CaptureContent((FrameworkElement)maintenanceDialog.Content,System.IO.Path.Combine(root,"maintenance-compact.png"));if(maintenanceBusy||!maintenanceActions[0].IsEnabled||maintenanceRecover.Visibility!=Visibility.Visible)throw new Exception("Maintenance recovery action is unavailable");foreach(var action in new[]{maintenanceCancel,maintenanceRecover})if(action.TranslatePoint(new Point(0,action.ActualHeight),(UIElement)maintenanceDialog.Content).Y>((FrameworkElement)maintenanceDialog.Content).ActualHeight)throw new Exception("Maintenance action is below the viewport");maintenanceContent.ScrollToEnd();maintenanceDialog.UpdateLayout();CaptureContent((FrameworkElement)maintenanceDialog.Content,System.IO.Path.Combine(root,"maintenance-tools.png"));maintenanceDialog.Close();recoveryPending=false;
    }
    static void OpenInstaller(){
        if(maintenanceBusy)return;string executable=System.IO.Path.Combine(root,"WhaleSetup.exe");if(!System.IO.File.Exists(executable)){maintenanceStatus.Text="当前构建缺少安装工具，请使用完整新版发行包。";return;}
        if(MessageBox.Show(maintenanceDialog,"将退出当前工作台并停止机器人，然后打开安装升级工具。请先准备已解压的完整新发行包，是否继续？","打开安装升级工具",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;
        try{System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(executable,"--data-dir \""+dataRoot.Replace("\"","")+"\""){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true});maintenanceDialog.Close();Exit();}catch{maintenanceStatus.Text="安装工具无法打开，请检查完整发行文件。";}
    }
}
