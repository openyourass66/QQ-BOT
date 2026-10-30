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
    static readonly List<Button> maintenanceActions=new List<Button>();
    static bool maintenanceBusy,recoveryPending;

    static void BuildMaintenanceCard(StackPanel panel) {
        var body=new StackPanel();var button=new Button {Content="数据备份与恢复",HorizontalAlignment=HorizontalAlignment.Left,MinHeight=36,Margin=new Thickness(0,8,0,10)};
        System.Windows.Automation.AutomationProperties.SetAutomationId(button,"OpenMaintenance");button.Click+=(s,e)=>OpenMaintenance();body.Children.Add(button);
        body.Children.Add(new TextBlock {Text="停止机器人后，创建加密备份、校验备份或恢复原实例的数据。",TextWrapping=TextWrapping.Wrap,Foreground=Ink("Muted"),LineHeight=20});
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
        var actions=new WrapPanel();maintenanceActions.Clear();foreach(var pair in new[]{new[]{"创建加密备份","backup"},new[]{"校验备份","verify"},new[]{"恢复备份","restore"}}){string operation=pair[1];var button=new Button {Content=pair[0],MinHeight=36,Margin=new Thickness(0,0,10,10)};button.Click+=(s,e)=>RequestMaintenance(operation);actions.Children.Add(button);maintenanceActions.Add(button);}body.Children.Add(actions);
        body.Children.Add(new TextBlock {Text="恢复仅支持原实例与相同数据路径。校验通过后先保存当前数据恢复点，再切换文件；失败会尝试撤回。请保持程序打开。",TextWrapping=TextWrapping.Wrap,LineHeight=20,Foreground=Ink("Muted"),Margin=new Thickness(0,3,0,16)});
        maintenanceRecover=new Button {Content="处理上次中断",HorizontalAlignment=HorizontalAlignment.Left,MinHeight=34,Margin=new Thickness(0,0,0,12),Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed};maintenanceRecover.Click+=(s,e)=>RequestMaintenance("recover");body.Children.Add(maintenanceRecover);
        maintenanceProgress=new ProgressBar {Height=5,IsIndeterminate=true,Visibility=Visibility.Collapsed,Margin=new Thickness(0,0,0,12)};body.Children.Add(maintenanceProgress);
        maintenanceStatus=new TextBlock {Text="请选择操作。备份包含私人数据，请妥善保管。",TextWrapping=TextWrapping.Wrap,LineHeight=21,MinHeight=50,Margin=new Thickness(0,0,0,12)};System.Windows.Automation.AutomationProperties.SetName(maintenanceStatus,"维护结果");body.Children.Add(maintenanceStatus);
        var footer=new WrapPanel();maintenanceCancel=new Button {Content="取消操作",IsEnabled=false,Margin=new Thickness(0,0,10,0),MinHeight=34};maintenanceCancel.Click+=(s,e)=>{maintenanceCancel.IsEnabled=false;maintenanceStatus.Text="正在取消，等待保留或撤回未完成操作…";Send("maintenance-cancel");};footer.Children.Add(maintenanceCancel);var close=new Button {Content="关闭",MinHeight=34};close.Click+=(s,e)=>maintenanceDialog.Close();footer.Children.Add(close);body.Children.Add(footer);
        body.Children.Remove(maintenanceProgress);body.Children.Remove(maintenanceStatus);body.Children.Remove(footer);
        body.Children.Remove(maintenanceRecover);maintenanceRecover.Margin=new Thickness(0,0,10,0);footer.Children.Insert(0,maintenanceRecover);
        var statusPanel=new StackPanel();statusPanel.Children.Add(maintenanceProgress);statusPanel.Children.Add(maintenanceStatus);
        var fixedStatus=new ScrollViewer {Content=statusPanel,MaxHeight=140,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Margin=new Thickness(0,10,0,8)};
        var dock=new DockPanel();DockPanel.SetDock(footer,Dock.Bottom);dock.Children.Add(footer);DockPanel.SetDock(fixedStatus,Dock.Bottom);dock.Children.Add(fixedStatus);dock.Children.Add(new ScrollViewer {Content=body,VerticalScrollBarVisibility=ScrollBarVisibility.Auto});
        maintenanceDialog.Content=new Border {Padding=new Thickness(24),Background=window.Background,Child=dock};
        maintenanceDialog.Closing+=(s,e)=>{if(maintenanceBusy){e.Cancel=true;maintenanceStatus.Text="维护正在进行，请先取消并等待完成。";return;}maintenancePassword.Clear();maintenanceConfirmation.Clear();};maintenanceDialog.Closed+=(s,e)=>{maintenanceDialog=null;maintenanceActions.Clear();};
        if(preview){maintenanceDialog.Show();return;}Send("maintenance",new {operation="status"});maintenanceDialog.ShowDialog();
    }
    static void SetMaintenanceBusy(bool value) {maintenanceBusy=value;if(maintenanceDialog==null)return;foreach(var button in maintenanceActions)button.IsEnabled=!value;maintenancePassword.IsEnabled=!value;maintenanceConfirmation.IsEnabled=!value;maintenanceRecover.IsEnabled=!value;maintenanceCancel.IsEnabled=value;maintenanceProgress.Visibility=value?Visibility.Visible:Visibility.Collapsed;}
    static void RequestMaintenance(string operation) {
        if(maintenanceBusy)return;
        if(operation=="recover"){if(MessageBox.Show(maintenanceDialog,"处理上次恢复中断，可能撤回尚未完成的数据切换。是否继续？","处理恢复中断",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;SetMaintenanceBusy(true);Send("maintenance",new {operation=operation});return;}
        string password=maintenancePassword.Password;if(password.Length<12){maintenanceStatus.Text="请输入至少 12 个字符的备份密码。";maintenancePassword.Focus();return;}if(operation=="backup"&&password!=maintenanceConfirmation.Password){maintenanceStatus.Text="两次输入的密码不一致。";maintenanceConfirmation.Focus();return;}
        string file;if(operation=="backup"){var picker=new Microsoft.Win32.SaveFileDialog {Title="保存加密备份",Filter="小鲸加密备份|*.wwbackup",DefaultExt=".wwbackup",FileName="小鲸备份-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+".wwbackup"};if(picker.ShowDialog(maintenanceDialog)!=true)return;file=picker.FileName;}else{var picker=new Microsoft.Win32.OpenFileDialog {Title=operation=="restore"?"选择要恢复的备份":"选择要校验的备份",Filter="小鲸加密备份|*.wwbackup"};if(picker.ShowDialog(maintenanceDialog)!=true)return;file=picker.FileName;}
        if(operation=="restore"&&MessageBox.Show(maintenanceDialog,"恢复将替换当前实例的配置、聊天记录、人设、记忆和媒体。程序会先创建当前数据的加密恢复点。确认恢复此备份？","恢复数据",MessageBoxButton.YesNo,MessageBoxImage.Warning)!=MessageBoxResult.Yes)return;
        maintenanceStatus.Text=operation=="backup"?"正在准备加密备份…":"正在检查备份…";SetMaintenanceBusy(true);Send("maintenance",new {operation=operation,file=file,password=password});
    }
    static void RenderMaintenance(Dictionary<string,object> message) {
        string operation=Convert.ToString(message["operation"]);if(operation=="status"){recoveryPending=message.ContainsKey("recoveryPending")&&(bool)message["recoveryPending"];if(maintenanceDialog!=null){maintenanceRecover.Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed;if(recoveryPending)maintenanceStatus.Text="上次恢复尚未收尾，请先点击“处理上次中断”。";}return;}
        SetMaintenanceBusy(false);recoveryPending=false;if(maintenanceDialog!=null){maintenancePassword.Clear();maintenanceConfirmation.Clear();maintenanceRecover.Visibility=Visibility.Collapsed;maintenanceStatus.Text=operation=="backup"?"加密备份已保存：\n"+Convert.ToString(message["file"]):operation=="verify"?"备份校验通过，共 "+message["files"]+" 个文件。":operation=="restore"?"数据已恢复。切换前的加密恢复点：\n"+Convert.ToString(message["recoveryPoint"]):"中断处理完成，可以重新检查并启动机器人。";}
        if(operation=="restore"||operation=="recover"){Send("load");Send("diagnose");}
    }
    static void RenderMaintenanceProgress(Dictionary<string,object> message) {if(maintenanceDialog==null)return;var labels=new Dictionary<string,string>{{"reading","正在读取并加密数据"},{"verifying","正在解密并校验文件"},{"recovery-point","正在保存当前数据恢复点"},{"switching","正在切换数据，取消时将尝试撤回"},{"complete","维护已完成"}};string stage=Convert.ToString(message["stage"]);maintenanceStatus.Text=(labels.ContainsKey(stage)?labels[stage]:"正在维护数据")+"\n已处理 "+message["files"]+" 个文件";}
    static void MaintenanceError(string text) {SetMaintenanceBusy(false);if(maintenanceDialog!=null){maintenancePassword.Clear();maintenanceConfirmation.Clear();maintenanceStatus.Text=text;maintenanceRecover.Visibility=recoveryPending?Visibility.Visible:Visibility.Collapsed;}}
    static void MaintenanceSmoke() {
        OpenMaintenance(true);SetMaintenanceBusy(true);if(maintenanceActions[0].IsEnabled||!maintenanceCancel.IsEnabled)throw new Exception("Maintenance controls are not protected");
        recoveryPending=true;MaintenanceError("测试：恢复中断，原数据保留。请处理上次中断后再启动。");maintenanceDialog.Width=480;maintenanceDialog.Height=540;maintenanceDialog.UpdateLayout();CaptureContent((FrameworkElement)maintenanceDialog.Content,System.IO.Path.Combine(root,"maintenance-compact.png"));if(maintenanceBusy||!maintenanceActions[0].IsEnabled||maintenanceRecover.Visibility!=Visibility.Visible)throw new Exception("Maintenance recovery action is unavailable");foreach(var action in new[]{maintenanceCancel,maintenanceRecover})if(action.TranslatePoint(new Point(0,action.ActualHeight),(UIElement)maintenanceDialog.Content).Y>((FrameworkElement)maintenanceDialog.Content).ActualHeight)throw new Exception("Maintenance action is below the viewport");maintenanceDialog.Close();recoveryPending=false;
    }
}
