using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;

partial class App
{
    static Window componentDialog;
    static StackPanel componentRows;
    static TextBlock componentStatus;
    static ProgressBar componentProgress;
    static Button componentCancel;
    static bool componentBusy;
    static readonly List<Button> componentActions = new List<Button>();
    static Dictionary<string,string> componentBaseline = new Dictionary<string,string>();
    static void OpenComponents(bool preview = false) {
        if(componentDialog!=null) {componentDialog.Activate();return;}
        componentDialog=new Window {Title="准备运行组件",Owner=window,Width=590,Height=520,MinWidth=500,MinHeight=400,WindowStartupLocation=WindowStartupLocation.CenterOwner,Resources=window.Resources,Background=window.Background,Foreground=window.Foreground,FontFamily=window.FontFamily,FontSize=13};
        var layout=new Grid {Background=window.Background};
        layout.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});layout.RowDefinitions.Add(new RowDefinition());layout.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});
        layout.Children.Add(new TextBlock {Text="从官方来源准备固定版本。模型组件首次准备可能需要几分钟；QQ 组件约 118 MB。完成后补全路径草稿，保存后生效。",TextWrapping=TextWrapping.Wrap,LineHeight=21,Margin=new Thickness(0,0,0,18)});
        componentRows=new StackPanel();var scroll=new ScrollViewer {Content=componentRows,VerticalScrollBarVisibility=ScrollBarVisibility.Auto};Grid.SetRow(scroll,1);layout.Children.Add(scroll);
        var footer=new StackPanel {Margin=new Thickness(0,16,0,0)};Grid.SetRow(footer,2);layout.Children.Add(footer);
        componentStatus=new TextBlock {Text="正在读取组件状态…",TextWrapping=TextWrapping.Wrap,LineHeight=20,Margin=new Thickness(0,0,0,10)};
        System.Windows.Automation.AutomationProperties.SetAutomationId(componentStatus,"ComponentStatus");footer.Children.Add(componentStatus);
        componentProgress=new ProgressBar {Height=5,Visibility=Visibility.Collapsed,Margin=new Thickness(0,0,0,12)};footer.Children.Add(componentProgress);
        componentCancel=new Button {Content="取消准备",HorizontalAlignment=HorizontalAlignment.Left,Visibility=Visibility.Collapsed};componentCancel.Click+=(s,e)=>{componentCancel.IsEnabled=false;componentStatus.Text="正在取消并清理临时文件…";Send("components-cancel");};footer.Children.Add(componentCancel);
        componentDialog.Content=new Border {Padding=new Thickness(24),Background=window.Background,Child=layout};
        componentDialog.Closed+=(s,e)=>{if(componentBusy)Send("components-cancel");componentDialog=null;};
        if(preview){componentDialog.Show();return;}
        Send("components",new {operation="list"});componentDialog.ShowDialog();
    }
    static void PrepareComponent(string id, bool local) {
        if(componentBusy)return;
        string archive=null;
        if(local) {var picker=new Microsoft.Win32.OpenFileDialog {Title="选择官方 QQ 组件包",Filter="官方组件 ZIP|*.zip"};if(picker.ShowDialog(componentDialog)!=true)return;archive=picker.FileName;}
        componentBaseline=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key));
        componentBusy=true;componentStatus.Text="正在准备，请保持工作台打开。";componentProgress.IsIndeterminate=true;componentProgress.Visibility=Visibility.Visible;
        componentCancel.Visibility=Visibility.Visible;componentCancel.IsEnabled=true;foreach(var button in componentActions)button.IsEnabled=false;
        Send("components",new {operation="install",id=id,archivePath=archive});
    }
    static void RenderComponents(Dictionary<string,object> message) {
        componentBusy=false;
        if(componentDialog==null)return;
        componentRows.Children.Clear();componentActions.Clear();
        foreach(Dictionary<string,object> row in (IEnumerable)message["rows"]) {
            string id=(string)row["id"];bool installed=(bool)row["installed"],supported=(bool)row["supported"];
            var body=new StackPanel {Margin=new Thickness(0,0,0,20)};
            body.Children.Add(new TextBlock {Text=(string)row["name"],FontSize=16,FontWeight=FontWeights.SemiBold});
            body.Children.Add(new TextBlock {Text="版本 "+row["version"]+" · "+(!supported?"仅支持 Windows x64":installed?"已就绪":"尚未准备"),Foreground=Ink("Muted"),Margin=new Thickness(0,6,0,10)});
            var actions=new WrapPanel();body.Children.Add(actions);
            var install=new Button {Content=installed?"重新准备":"下载并准备",IsEnabled=supported,Margin=new Thickness(0,0,8,8)};
            System.Windows.Automation.AutomationProperties.SetAutomationId(install,"ComponentPrepare-"+id);install.Click+=(s,e)=>PrepareComponent(id,false);componentActions.Add(install);actions.Children.Add(install);
            if(id=="napcat") {var import=new Button {Content="导入官方组件包",IsEnabled=supported,Margin=new Thickness(0,0,0,8)};import.Click+=(s,e)=>PrepareComponent(id,true);componentActions.Add(import);actions.Children.Add(import);}
            componentRows.Children.Add(body);
        }
        int applied=0;bool dshPathApplied=false;
        if(message.ContainsKey("suggestions"))foreach(Dictionary<string,object> item in (IEnumerable)message["suggestions"]) {
            string key=(string)item["key"];
            if(key=="BOT_DSH_HOME"&&!dshPathApplied)continue;
            if(!runtimeInputs.ContainsKey(key)||!componentBaseline.ContainsKey(key)||RuntimeValue(key)!=componentBaseline[key])continue;
            string value=RuntimeValue(key),before=item.ContainsKey("previous")?item["previous"] as string:"";
            if(!string.IsNullOrWhiteSpace(value)&&value!="dsh.cmd"&&value!="napcat/shell"&&value!=before)continue;
            var input=runtimeInputs[key] as TextBox;if(input!=null){input.Text=(string)item["value"];applied++;if(key=="BOT_DSH_BIN")dshPathApplied=true;}
        }
        componentStatus.Text=message.ContainsKey("installed")?(applied>0?"组件已就绪，路径已填入草稿。关闭此窗口后检查并保存配置。":"组件已就绪，已有自定义路径保留。"):"选择需要的组件。准备失败可重试，QQ 组件也可导入本地官方包。";
        componentProgress.Visibility=Visibility.Collapsed;componentCancel.Visibility=Visibility.Collapsed;
    }
    static void RenderComponentProgress(Dictionary<string,object> message) {
        if(componentDialog==null)return;
        string phase=(string)message["phase"],id=(string)message["id"],name=id=="node"?"模型运行环境":id=="dsh"?"模型运行器":"QQ 接入组件";
        componentProgress.Visibility=Visibility.Visible;componentProgress.IsIndeterminate=phase!="downloading";
        componentStatus.Text=name+" · "+(phase=="downloading"?"正在下载":phase=="copying"?"正在复制内置运行环境":phase=="extracting"?"正在解压":phase=="installing"?"正在准备依赖，请稍候":phase=="ready"?"已准备":"正在检查文件与版本");
        if(phase=="downloading"&&message.ContainsKey("total")){double received=Convert.ToDouble(message["received"]),total=Convert.ToDouble(message["total"]);componentProgress.Maximum=total;componentProgress.Value=received;componentStatus.Text+=" "+(received/1048576).ToString("0.0")+" / "+(total/1048576).ToString("0.0")+" MB";}
    }
    static void ComponentError(string text) {
        componentBusy=false;
        if(componentDialog==null)return;
        componentStatus.Text=text;componentProgress.Visibility=Visibility.Collapsed;componentCancel.Visibility=Visibility.Collapsed;foreach(var button in componentActions)button.IsEnabled=true;
    }
    static void VerifyComponentInteraction() {
        var original=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key));
        OpenComponents(true);
        var rows=new object[]{new Dictionary<string,object>{{"id","dsh"},{"name","模型运行器 DSH"},{"version","0.2.1-rc.2"},{"installed",false},{"supported",true}},new Dictionary<string,object>{{"id","napcat"},{"name","QQ 接入组件"},{"version","4.18.41"},{"installed",true},{"supported",true}}};
        RenderComponents(new Dictionary<string,object>{{"rows",rows}});
        if(componentActions.Count!=3)throw new Exception("Component install/import actions are missing");
        componentBaseline=new Dictionary<string,string>(original);componentBaseline["BOT_DSH_BIN"]="changed-before-result";
        RenderComponents(new Dictionary<string,object>{{"rows",rows},{"suggestions",new object[]{new Dictionary<string,object>{{"key","BOT_DSH_BIN"},{"value","unexpected.cmd"}}}}});
        if(RuntimeValue("BOT_DSH_BIN")!=original["BOT_DSH_BIN"])throw new Exception("Component result overwrote a newer draft");
        loading=true;((TextBox)runtimeInputs["BOT_DSH_BIN"]).Text="external-custom.cmd";loading=false;
        componentBaseline=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key));
        RenderComponents(new Dictionary<string,object>{{"rows",rows},{"suggestions",new object[]{new Dictionary<string,object>{{"key","BOT_DSH_BIN"},{"value","new-managed.cmd"}},new Dictionary<string,object>{{"key","BOT_DSH_HOME"},{"value","new-managed-home"}}}}});
        if(RuntimeValue("BOT_DSH_BIN")!="external-custom.cmd"||RuntimeValue("BOT_DSH_HOME")!=original["BOT_DSH_HOME"])throw new Exception("Preparing a component changed an external login directory");
        loading=true;((TextBox)runtimeInputs["BOT_DSH_BIN"]).Text=original["BOT_DSH_BIN"];loading=false;
        RenderComponentProgress(new Dictionary<string,object>{{"id","napcat"},{"phase","downloading"},{"received",50*1048576},{"total",118*1048576}});
        if(componentProgress.IsIndeterminate||componentProgress.Value!=50*1048576)throw new Exception("Download progress is incorrect");
        componentDialog.UpdateLayout();CaptureContent((FrameworkElement)componentDialog.Content,System.IO.Path.Combine(root,"components-ready.png"));
        componentDialog.Width=500;componentDialog.Height=400;ComponentError("下载失败，请检查网络后重试，或导入本地官方组件包。已有组件继续保留。");componentDialog.UpdateLayout();
        if(componentActions.Any(button=>!button.IsEnabled)||componentCancel.Visibility!=Visibility.Collapsed)throw new Exception("Component recovery actions remain disabled");
        CaptureContent((FrameworkElement)componentDialog.Content,System.IO.Path.Combine(root,"components-compact.png"));componentDialog.Close();
    }
}
