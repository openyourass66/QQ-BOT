using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;

partial class App
{
    static readonly string[] scopePaths = { "approval.adminQq", "social.allowAll", "social.allowedUsers", "social.allowedGroups" };
    static Dictionary<string,object> quickScope;
    static Window scopeDialog;
    static TextBlock scopeStatus;
    static Button scopeRead, scopeApply;
    static ComboBox scopeOwner;
    static ListBox scopeFriends, scopeGroups;
    static List<ScopeChoice> scopeFriendItems = new List<ScopeChoice>(), scopeGroupItems = new List<ScopeChoice>();
    static Dictionary<string,object> scopeLoaded;
    static int scopeReadRevision;
    static string scopeRequestId;
    static bool scopeBusy;
    public class ScopeChoice : INotifyPropertyChanged {
        public string Id { get; set; }
        public string Label { get; set; }
        bool selected;
        public bool Selected { get {return selected;} set {selected=value;if(PropertyChanged!=null)PropertyChanged(this,new PropertyChangedEventArgs("Selected"));} }
        public bool Enabled { get; set; }
        public event PropertyChangedEventHandler PropertyChanged;
    }
    static bool NeedsScope() {return settings!=null&&settings.ContainsKey("installation")&&!Convert.ToBoolean(((Dictionary<string,object>)settings["installation"])["scopeConfigured"]);}
    static void OpenScopeSetup(bool preview=false) {
        if(scopeDialog!=null){scopeDialog.Activate();return;}
        if(dirtySettingPaths.Any(scopePaths.Contains)){Feedback("请先保存机器人设置中的主人或联系范围草稿，再打开使用范围。");return;}
        scopeDialog=new Window {Title="选择主人和联系范围",Owner=window,Width=800,Height=Math.Min(700,SystemParameters.WorkArea.Height-40),MinWidth=600,MinHeight=520,WindowStartupLocation=WindowStartupLocation.CenterOwner,Resources=window.Resources,Background=window.Background,Foreground=window.Foreground,FontFamily=window.FontFamily,FontSize=13};
        var panel=new Grid {Background=window.Background};
        foreach(var height in new[]{GridLength.Auto,GridLength.Auto,GridLength.Auto,GridLength.Auto,new GridLength(1,GridUnitType.Star),GridLength.Auto})panel.RowDefinitions.Add(new RowDefinition{Height=height});
        panel.Children.Add(new TextBlock {Text="只在你选择的范围内聊天",FontSize=21,FontWeight=FontWeights.SemiBold,TextWrapping=TextWrapping.Wrap});
        var help=new TextBlock {Text="登录机器人 QQ 后读取实际好友和群。主人会加入允许私聊范围；暂不设置主人时，账号管理和需要确认的操作不可用。",TextWrapping=TextWrapping.Wrap,LineHeight=21,Margin=new Thickness(0,10,0,12)};Grid.SetRow(help,1);panel.Children.Add(help);
        var ownerRow=new DockPanel {Margin=new Thickness(0,0,0,12)};
        ownerRow.Children.Add(new TextBlock {Text="机器人主人",VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(0,0,16,0)});
        scopeOwner=new ComboBox {MinWidth=220,HorizontalAlignment=HorizontalAlignment.Stretch,DisplayMemberPath="Label",SelectedValuePath="Value"};ownerRow.Children.Add(scopeOwner);
        scopeOwner.SelectionChanged+=(s,e)=>{var selectedOwner=e.AddedItems.Cast<Choice>().FirstOrDefault();var contact=selectedOwner==null?null:scopeFriendItems.FirstOrDefault(item=>item.Id==selectedOwner.Value&&item.Enabled);if(contact!=null)contact.Selected=true;UpdateScopeSelection();};
        System.Windows.Automation.AutomationProperties.SetName(scopeOwner,"机器人主人");System.Windows.Automation.AutomationProperties.SetAutomationId(scopeOwner,"ScopeOwner");Grid.SetRow(ownerRow,2);panel.Children.Add(ownerRow);
        scopeStatus=new TextBlock {Text="点击读取联系人，不会发送消息或调用模型。",TextWrapping=TextWrapping.Wrap,LineHeight=20,Margin=new Thickness(0,0,0,12)};Grid.SetRow(scopeStatus,3);panel.Children.Add(scopeStatus);
        var columns=new Grid();columns.ColumnDefinitions.Add(new ColumnDefinition());columns.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(16)});columns.ColumnDefinitions.Add(new ColumnDefinition());
        scopeFriends=ScopeList(columns,"允许私聊的好友",0,true);scopeGroups=ScopeList(columns,"允许聊天的群",2,false);Grid.SetRow(columns,4);panel.Children.Add(columns);
        var footer=new StackPanel {Margin=new Thickness(0,14,0,0)};
        footer.Children.Add(new TextBlock {Text="将使用有限名单；屏蔽名单继续优先。后台自主活动、空间与其他功能保持当前设置，新实例默认关闭后台自主活动。",TextWrapping=TextWrapping.Wrap,Foreground=Ink("Muted"),LineHeight=20,Margin=new Thickness(0,0,0,10)});
        var actions=new WrapPanel {HorizontalAlignment=HorizontalAlignment.Right};footer.Children.Add(actions);
        scopeRead=new Button {Content="读取联系人",Margin=new Thickness(0,0,8,8)};scopeRead.Click+=(s,e)=>ReadScopeContacts();actions.Children.Add(scopeRead);
        var cancel=new Button {Content="取消",Margin=new Thickness(0,0,8,8)};cancel.Click+=(s,e)=>scopeDialog.Close();actions.Children.Add(cancel);
        scopeApply=new Button {Content="使用所选范围",IsEnabled=false,Style=(Style)window.FindResource("Primary"),Margin=new Thickness(0,0,0,8)};scopeApply.Click+=(s,e)=>ApplyScopeDraft();actions.Children.Add(scopeApply);
        Grid.SetRow(footer,5);panel.Children.Add(footer);scopeDialog.Content=new Border {Padding=new Thickness(24),Background=window.Background,Child=panel};
        scopeLoaded=null;scopeBusy=false;scopeFriendItems.Clear();scopeGroupItems.Clear();
        scopeDialog.Closed+=(s,e)=>{scopeDialog=null;};
        if(preview){scopeDialog.Show();return;}
        ReadScopeContacts();scopeDialog.ShowDialog();
    }
    static ListBox ScopeList(Grid parent,string title,int column,bool friends) {
        var grid=new Grid();grid.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});grid.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});grid.RowDefinitions.Add(new RowDefinition());
        grid.Children.Add(new TextBlock {Text=title,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,8)});
        var search=new TextBox {Tag="按名称或号码筛选",ToolTip="按名称或号码筛选",Margin=new Thickness(0,0,0,8)};System.Windows.Automation.AutomationProperties.SetName(search,"筛选"+title);Grid.SetRow(search,1);grid.Children.Add(search);
        var list=new ListBox {Style=null,MinHeight=100,HorizontalContentAlignment=HorizontalAlignment.Stretch};
        list.ItemContainerStyle=new Style(typeof(ListBoxItem));list.ItemContainerStyle.Setters.Add(new Setter(Control.HorizontalContentAlignmentProperty,HorizontalAlignment.Stretch));ScrollViewer.SetHorizontalScrollBarVisibility(list,ScrollBarVisibility.Disabled);
        System.Windows.Automation.AutomationProperties.SetName(list,title);
        VirtualizingStackPanel.SetIsVirtualizing(list,true);VirtualizingStackPanel.SetVirtualizationMode(list,VirtualizationMode.Recycling);ScrollViewer.SetCanContentScroll(list,true);
        var check=new FrameworkElementFactory(typeof(CheckBox));check.SetValue(FrameworkElement.StyleProperty,null);check.SetBinding(CheckBox.IsCheckedProperty,new Binding("Selected"){Mode=BindingMode.TwoWay});check.SetBinding(CheckBox.IsEnabledProperty,new Binding("Enabled"));check.SetValue(FrameworkElement.MarginProperty,new Thickness(4,8,4,8));check.SetValue(Control.HorizontalContentAlignmentProperty,HorizontalAlignment.Stretch);
        var label=new FrameworkElementFactory(typeof(TextBlock));label.SetBinding(TextBlock.TextProperty,new Binding("Label"));label.SetValue(TextBlock.TextWrappingProperty,TextWrapping.Wrap);check.AppendChild(label);
        list.ItemTemplate=new DataTemplate {VisualTree=check};Grid.SetRow(list,2);grid.Children.Add(list);
        search.TextChanged+=(s,e)=>{var items=friends?scopeFriendItems:scopeGroupItems;string query=search.Text.Trim();list.ItemsSource=items.Where(item=>item.Label.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0).ToList();};
        Grid.SetColumn(grid,column);parent.Children.Add(grid);return list;
    }
    static void ReadScopeContacts() {
        if(scopeBusy)return;
        scopeBusy=true;scopeRead.IsEnabled=scopeApply.IsEnabled=false;scopeRead.Content="正在读取…";scopeStatus.Text="正在读取当前机器人账号的好友和群…";scopeReadRevision=quickRevision;
        scopeRequestId=Guid.NewGuid().ToString("N");
        Send("onboarding",new {operation="contacts",requestId=scopeRequestId,runtime=runtimeInputs.ToDictionary(pair=>pair.Key,pair=>RuntimeValue(pair.Key))});
    }
    static void ScopeError(string text) {scopeBusy=false;if(scopeDialog==null)return;scopeRead.IsEnabled=true;scopeRead.Content="重新读取";scopeApply.IsEnabled=false;scopeStatus.Text=text;scopeStatus.Foreground=Ink("Danger");}
    static void RenderScopeContacts(Dictionary<string,object> message) {
        if(scopeDialog==null||message.ContainsKey("requestId")&&Convert.ToString(message["requestId"])!=scopeRequestId)return;
        scopeBusy=false;
        scopeRead.IsEnabled=true;scopeRead.Content="重新读取";
        if(scopeReadRevision!=quickRevision){ScopeError("连接草稿已变化，请重新读取联系人。");return;}
        scopeLoaded=message;var baseline=(Dictionary<string,object>)message["baseline"];
        var previous=quickScope!=null&&(string)quickScope["account"]==(string)message["account"]?quickScope:baseline;
        var social=(Dictionary<string,object>)settings["social"];
        Func<object,HashSet<string>> ids=value=>new HashSet<string>(((IEnumerable)value).Cast<object>().Select(Convert.ToString));
        Func<string,string,List<ScopeChoice>> entries=(key,blockedKey)=>{
            var chosen=ids(previous[key=="friends"?"users":"groups"]);var blocked=ids(social[blockedKey]);
            return ((IEnumerable)message[key]).Cast<Dictionary<string,object>>().Select(row=>new ScopeChoice {Id=(string)row["id"],Label=row["name"]+" · "+row["id"]+(blocked.Contains((string)row["id"])?"（已屏蔽）":""),Selected=chosen.Contains((string)row["id"])&&!blocked.Contains((string)row["id"]),Enabled=!blocked.Contains((string)row["id"])}).ToList();
        };
        scopeFriendItems=entries("friends","blockedUsers");scopeGroupItems=entries("groups","blockedGroups");scopeFriends.ItemsSource=scopeFriendItems;scopeGroups.ItemsSource=scopeGroupItems;
        foreach(var item in scopeFriendItems.Concat(scopeGroupItems))item.PropertyChanged+=(s,e)=>UpdateScopeSelection();
        var owners=new List<Choice>{new Choice {Value="0",Label="暂不设置主人（仅基础聊天）"}};owners.AddRange(scopeFriendItems.Where(item=>item.Enabled).Select(item=>new Choice {Value=item.Id,Label=item.Label}));scopeOwner.ItemsSource=owners;
        string owner=Convert.ToString(previous["owner"]);scopeOwner.SelectedValue=owners.Any(item=>item.Value==owner)?owner:"0";
        scopeStatus.Text="机器人 QQ "+message["account"]+" · "+scopeFriendItems.Count+" 位好友，"+scopeGroupItems.Count+" 个群。勾选允许聊天的对象。";scopeStatus.Foreground=Ink("Muted");scopeApply.IsEnabled=true;
    }
    static void UpdateScopeSelection() {
        if(scopeDialog==null||scopeLoaded==null||scopeBusy)return;
        scopeStatus.Text="机器人 QQ "+scopeLoaded["account"]+" · 已选 "+scopeFriendItems.Count(item=>item.Selected)+" 位好友、"+scopeGroupItems.Count(item=>item.Selected)+" 个群。";scopeStatus.Foreground=Ink("Muted");
    }
    static void ApplyScopeDraft() {
        if(scopeBusy||scopeLoaded==null)return;
        if(scopeReadRevision!=quickRevision){ScopeError("连接草稿已变化，请重新读取联系人。");return;}
        string owner=Convert.ToString(scopeOwner.SelectedValue??"0");
        var users=scopeFriendItems.Where(item=>item.Selected&&item.Enabled).Select(item=>item.Id).ToList();var groups=scopeGroupItems.Where(item=>item.Selected&&item.Enabled).Select(item=>item.Id).ToArray();
        if(owner!="0"&&!users.Contains(owner))users.Add(owner);
        if(users.Count==0&&groups.Length==0){scopeStatus.Text="请至少选择一位好友或一个群，也可选择主人开始私聊。";scopeStatus.Foreground=Ink("Danger");return;}
        quickScope=new Dictionary<string,object>{{"account",scopeLoaded["account"]},{"owner",owner},{"users",users.ToArray()},{"groups",groups},{"baseline",scopeLoaded["baseline"]}};
        MarkDirty("scope");InvalidateQuickCheck();Find<TextBlock>("QuickNotice").Text="范围草稿："+users.Count+" 位好友、"+groups.Length+" 个群。检查后与连接配置一同保存。";scopeDialog.Close();
    }
    static void VerifyScopeInteraction() {
        if(FlattenSettings(settings).Keys.Any(key=>key.StartsWith("installation.")))throw new Exception("首次设置版本被当作行为参数编辑");
        OpenScopeSetup(true);scopeReadRevision=quickRevision;
        var message=new Dictionary<string,object>{{"operation","contacts"},{"account","90000"},{"friends",new object[]{new Dictionary<string,object>{{"id","80001"},{"name","测试主人"}},new Dictionary<string,object>{{"id","80002"},{"name","测试好友"}}}},{"groups",new object[]{new Dictionary<string,object>{{"id","70001"},{"name","测试群"}}}},{"baseline",new Dictionary<string,object>{{"owner","0"},{"allowAll",false},{"users",new string[0]},{"groups",new string[0]}}}};
        RenderScopeContacts(message);ApplyScopeDraft();if(scopeDialog==null||!scopeStatus.Text.Contains("至少"))throw new Exception("空联系范围被接受");
        scopeOwner.SelectedValue="80001";scopeGroupItems[0].Selected=true;scopeDialog.UpdateLayout();
        if(!scopeFriendItems[0].Selected)throw new Exception("选择主人后没有勾选对应好友");
        CaptureContent((FrameworkElement)scopeDialog.Content,System.IO.Path.Combine(root,"quick-scope.png"));
        scopeDialog.Width=600;scopeDialog.Height=520;scopeDialog.UpdateLayout();CaptureContent((FrameworkElement)scopeDialog.Content,System.IO.Path.Combine(root,"quick-scope-compact.png"));ApplyScopeDraft();
        if(quickScope==null||!((string[])quickScope["users"]).Contains("80001")||quickReady)throw new Exception("主人未加入私聊范围或范围修改未要求重新检查");
        quickScope=null;
        dirtySections.Remove("scope");
    }
}
