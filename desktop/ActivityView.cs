using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;

partial class App
{
    static bool socialBusy;
    static int visibleSocialSection;
    public class ActivityCategory {
        public string Key { get; set; }
        public string Name { get; set; }
        public string Group { get; set; }
        public ActivityCategory(string key,string name,string group) { Key=key;Name=name;Group=group; }
    }
    public partial class SocialRow {
        public string Avatar { get { return string.IsNullOrWhiteSpace(Name)?"鲸":Name.Trim().Substring(0,1); } }
        public Brush AvatarFill { get { return Color(Chat!=null&&Chat.StartsWith("group:")?"#EAF5F0":Chat!=null&&Chat.StartsWith("private:")?"#EEF1FF":"#F1EEFC"); } }
        public Brush AvatarInk { get { return Color(Chat!=null&&Chat.StartsWith("group:")?"#35755C":Chat!=null&&Chat.StartsWith("private:")?"#4B5FB4":"#735A9F"); } }
        public string ChatLabel { get { return string.IsNullOrEmpty(Chat)?(Status!=null&&Status.StartsWith("QQ收藏")?"QQ 收藏表情":Status!=null&&Status.StartsWith("仅本地")?"本地待同步":"本地记录"):Chat.StartsWith("private:")?"好友 · QQ "+Chat.Substring(8):Chat.StartsWith("group:")?"群聊 · "+Chat.Substring(6):Chat; } }
        public string SummaryDisplay { get { return Summary==Chat?ChatLabel:string.IsNullOrWhiteSpace(Summary)?ChatLabel:Summary.Replace("\r"," ").Replace("\n"," "); } }
        public string TimeLabel { get { DateTime date;return DateTime.TryParse(Time,out date)?date.ToString("MM-dd HH:mm"):""; } }
        public Brush StatusFill { get { return Color(IsGood?"#EAF5EF":IsWarning?"#FFF1E9":Status=="已注册"?"#EFF2FE":"#F0F3F8"); } }
        public Brush StatusInk { get { return Color(IsGood?"#2C7157":IsWarning?"#8B5A2C":Status=="已注册"?"#4B61AA":"#66748C"); } }
        bool IsGood { get { return new[]{"可联系","成功","完成","已发送","可检查"}.Contains(Status); } }
        bool IsWarning { get { return new[]{"已屏蔽","未在允许名单","失败","结果待核对","执行中","等待执行","等待条件恢复"}.Contains(Status); } }
    }
    static void InitActivityView() {
        var categories=new[]{
            new ActivityCategory("contacts","联系人与群","日常互动"),new ActivityCategory("messages","聊天记录","日常互动"),new ActivityCategory("stickers","QQ 收藏表情","日常互动"),new ActivityCategory("tasks","定时提醒","日常互动"),
            new ActivityCategory("thoughts","自主想法","自主活动"),new ActivityCategory("interests","兴趣偏好","自主活动"),new ActivityCategory("decisions","自主决策记录","自主活动"),
            new ActivityCategory("events","QQ 事件","运行记录"),new ActivityCategory("actions","工具执行结果","运行记录"),new ActivityCategory("turns","模型会话","运行记录"),new ActivityCategory("learning","后台学习记录","运行记录"),new ActivityCategory("capabilities","能力状态","运行记录")
        };
        var view=CollectionViewSource.GetDefaultView(categories);view.GroupDescriptions.Add(new PropertyGroupDescription("Group"));
        Find<ComboBox>("SocialSection").ItemsSource=view;Find<ComboBox>("SocialSection").SelectedIndex=0;
        Find<Button>("SocialRefresh").Click+=(s,e)=>SocialRequest();
        Find<Button>("SocialContacts").Click+=(s,e)=>SocialRequest("refresh_contacts");
        Find<Button>("SocialBlock").Click+=(s,e)=>SocialRequest("block");
        Find<Button>("SocialUnblock").Click+=(s,e)=>SocialRequest("block",false);
        Find<Button>("SocialSave").Click+=(s,e)=>SocialRequest(SocialSection==3?"collect_sticker":SocialSection==9?"defer_thought":"edit_interest");
        Find<Button>("SocialDelete").Click+=(s,e)=>SocialRequest("delete");
        Find<Button>("SocialReset").Click+=(s,e)=>SocialRequest("reset_session");
        Find<Button>("SocialProfile").Click+=(s,e)=>EditProfile();
        Find<TextBox>("SocialSearch").KeyDown+=(s,e)=>{if(e.Key==Key.Enter){e.Handled=true;SocialRequest();}if(e.Key==Key.Escape){Find<TextBox>("SocialSearch").Clear();e.Handled=true;}};
        Find<ComboBox>("SocialSection").SelectionChanged+=(s,e)=>{
            if(loading)return;
            if(!DiscardMemoryEdit()){loading=true;SocialSection=visibleSocialSection;loading=false;return;}
            visibleSocialSection=SocialSection;
            Find<Button>("SocialContacts").Visibility=visibleSocialSection==0?Visibility.Visible:Visibility.Collapsed;
            SocialRequest();
        };
        Find<ListView>("SocialList").SelectionChanged+=(s,e)=>{
            if(loading)return;
            var row=Find<ListView>("SocialList").SelectedItem as SocialRow;
            if(row!=socialSelection&&!DiscardMemoryEdit()){loading=true;Find<ListView>("SocialList").SelectedItem=socialSelection;loading=false;return;}
            socialSelection=row;ShowActivityDetail(row);
        };
        Find<TextBox>("SocialDetail").TextChanged+=(s,e)=>{if(!Find<TextBox>("SocialDetail").IsReadOnly)MarkDirty("memory");};
        ShowActivityDetail(null);
    }
    static bool DiscardMemoryEdit() {
        if(!dirtySections.Contains("memory"))return true;
        if(MessageBox.Show(window,"记录尚未保存，放弃这次编辑并继续？","记录编辑",MessageBoxButton.YesNo)!=MessageBoxResult.Yes)return false;
        dirtySections.Remove("memory");dirty=dirtySections.Count>0;return true;
    }
    static void SetSocialBusy(bool busy) {
        socialBusy=busy;
        Find<Button>("SettingsRefresh").IsEnabled=!busy&&!settingsStatusBusy;
        Find<Button>("SocialRefresh").IsEnabled=!busy;Find<Button>("SocialContacts").IsEnabled=!busy;Find<ComboBox>("SocialSection").IsEnabled=!busy;
        Find<TextBox>("SocialSearch").IsEnabled=!busy;Find<StackPanel>("SocialActionPanel").IsEnabled=!busy;Find<TextBox>("SocialDetail").IsEnabled=!busy;
        Find<Button>("SocialRefresh").Content=busy?"读取中…":SocialSection==3?"刷新 QQ 收藏":"刷新列表";
    }
    static void RenderActivity(Dictionary<string,object> message) {
        if(profileDialog!=null&&message.ContainsKey("op")&&(string)message["op"]=="profile")profileDialog.Close();
        loading=true;RenderSettingsStatus(message);
        var rows=new List<SocialRow>();
        foreach(Dictionary<string,object> row in (IEnumerable)message["rows"])rows.Add(new SocialRow {Id=(string)row["id"],Chat=(string)row["chat"],Name=(string)row["name"],Summary=(string)row["summary"],Status=(string)row["status"],Time=(string)row["time"],Detail=(string)row["detail"],Text=(string)row["text"]});
        Find<ListView>("SocialList").ItemsSource=rows;socialSelection=null;
        Find<TextBlock>("SocialCount").Text=((ActivityCategory)Find<ComboBox>("SocialSection").SelectedItem).Name+"  ·  "+Convert.ToString(message["total"])+" 条";
        Find<TextBlock>("SocialNote").Text=visibleSocialSection==3?Convert.ToString(message["note"]):rows.Count>0?"按需刷新 · 时间为上海时间":"暂无记录";
        Find<TextBlock>("SocialNote").ToolTip=message["note"];
        Find<StackPanel>("SocialEmpty").Visibility=rows.Count==0?Visibility.Visible:Visibility.Collapsed;
        Find<TextBlock>("SocialEmptyTitle").Text=Find<TextBox>("SocialSearch").Text.Length>0?"没有找到相关记录":"这里还没有记录";
        Find<TextBlock>("SocialEmptyHint").Text=Find<TextBox>("SocialSearch").Text.Length>0?"换个关键词，或清空搜索后再试。":visibleSocialSection==0?"启动机器人后，点击同步联系人。":"小鲸开始互动后，记录会出现在这里。";
        dirtySections.Remove("memory");dirty=dirtySections.Count>0;
        loading=false;ReconcileDirtySettings();SetSocialBusy(false);
        if(rows.Count>0)Find<ListView>("SocialList").SelectedIndex=0;else ShowActivityDetail(null);
        Feedback("QQ 活动已更新。");
    }
    static bool settingsStatusBusy;
    static void RenderSettingsStatus(Dictionary<string,object> message) {
        bool wasLoading=loading;loading=true;socialProfiles.Clear();
        if(message.ContainsKey("profiles"))foreach(Dictionary<string,object> profile in (IEnumerable)message["profiles"])socialProfiles[(string)profile["chat"]]=profile;
        bool sameSettings=!message.ContainsKey("settingsPath")||settingsPath.Length==0||string.Equals(Convert.ToString(message["settingsPath"]),settingsPath,StringComparison.OrdinalIgnoreCase);
        if(message.ContainsKey("socialSettings")&&settings!=null&&sameSettings){
            var remote=(Dictionary<string,object>)message["socialSettings"];var local=(Dictionary<string,object>)settings["social"];
            foreach(string key in new[]{"blockedGroups","blockedUsers","allowedGroups","allowedUsers"}) {
                string path="social."+key;var saved=((IEnumerable)local[key]).Cast<object>().Select(v=>v.ToString()).ToArray();
                var received=((IEnumerable)remote[key]).Cast<object>().Select(v=>v.ToString()).ToArray();var draft=ListValues(((TextBox)fields[path]).Text);
                var removed=new HashSet<string>(saved.Except(draft));
                var merged=received.Where(id=>!removed.Contains(id)).Concat(draft.Except(saved)).Distinct();
                local[key]=remote[key];savedSettingValues[path]=json.Serialize(remote[key]);((TextBox)fields[path]).Text=string.Join(", ",merged);
            }
        }
        if(message.ContainsKey("quotas")&&message["quotas"] is Dictionary<string,object>) {
            var quota=(Dictionary<string,object>)message["quotas"];var quotaRows=((IEnumerable)quota["rows"]).Cast<Dictionary<string,object>>().ToList();
            Find<TextBlock>("SettingsQuota").Text=(sameSettings?"":"机器人仍使用另一份配置，请重新启动。\n")+"今日额度 · "+quota["date"]+" · "+((bool)quota["live"]?"运行中快照":"离线记录")+"\n按已保存的额度统计，草稿保存后生效。";
            Find<TextBlock>("SettingsQuota").ToolTip=string.Join("\n",quotaRows.Select(q=>q["label"]+"：已用 "+q["used"]+"，上限 "+q["limit"]+"，剩余 "+q["remaining"]));
            var cards=Find<System.Windows.Controls.Primitives.UniformGrid>("SettingsQuotaCards");cards.Children.Clear();
            foreach(var quotaRow in quotaRows.Where(q=>!Convert.ToString(q["key"]).StartsWith("group:"))) {
                var body=new StackPanel();body.Children.Add(new TextBlock{Text=Convert.ToString(quotaRow["label"]),FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap});
                body.Children.Add(new TextBlock{Text=quotaRow["used"]+" / "+quotaRow["limit"],FontSize=18,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,6,0,4)});
                body.Children.Add(new TextBlock{Text="已用 / 上限 · 剩余 "+quotaRow["remaining"],FontSize=10,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap});
                cards.Children.Add(new Border{Background=Color("#F7F9FD"),CornerRadius=new CornerRadius(8),Padding=new Thickness(12),Margin=new Thickness(4),Child=body});
            }
            var groups=quotaRows.Where(q=>Convert.ToString(q["key"]).StartsWith("group:")).ToList();
            Find<Expander>("SettingsGroupQuotas").Visibility=groups.Count>0?Visibility.Visible:Visibility.Collapsed;
            Find<TextBlock>("SettingsGroupQuotaText").Text=string.Join("\n",groups.Select(q=>q["label"]+"：已用 "+q["used"]+" / "+q["limit"]+" · 剩余 "+q["remaining"]));
        }
        var modelUsage=message.ContainsKey("modelUsage")?message["modelUsage"] as Dictionary<string,object>:null;
        Find<TextBlock>("SettingsModelUsage").Text=modelUsage==null?"服务用量尚无记录。":"今日服务请求 "+modelUsage["requests"]+" 次（前台 "+modelUsage["foreground"]+" / 后台 "+modelUsage["background"]+"）；已上报完整用量 "+modelUsage["usageKnown"]+" 次，未上报或不适用 "+modelUsage["usageUnknown"]+" 次。\n已上报 Token：输入 "+modelUsage["knownInputTokens"]+" / 输出 "+modelUsage["knownOutputTokens"]+"。结果待核对 "+modelUsage["unknownResults"]+" 次。以上为服务上报值，不估算费用。";
        loading=wasLoading;settingsStatusBusy=false;Find<Button>("SettingsRefresh").Content="刷新额度";Find<Button>("SettingsRefresh").IsEnabled=!socialBusy;
        if(!loading)ReconcileDirtySettings();
    }
    static void ShowActivityDetail(SocialRow row) {
        bool interest=SocialSection==10;
        loading=true;
        int section=SocialSection;
        var editor=Find<TextBox>("SocialDetail");editor.IsReadOnly=!interest;editor.MaxLength=interest?80:0;
        editor.Text=row==null?"":interest?row.Text:row.Detail;
        editor.Background=interest?Color("#FAFBFE"):Brushes.Transparent;editor.BorderThickness=interest?new Thickness(1):new Thickness(0);editor.Padding=interest?new Thickness(12):new Thickness(0);
        Find<TextBlock>("SocialDetailTitle").Text=row==null?"尚未选择记录":row.Name;
        Find<TextBlock>("SocialDetailMeta").Text=row==null?"选择左侧一条记录查看详情。":row.ChatLabel+(string.IsNullOrEmpty(row.Time)?"":"\n"+row.Time);
        Find<TextBlock>("SocialState").Text=row==null?"":row.Status;
        Find<Border>("SocialDetailBadge").Visibility=row==null?Visibility.Collapsed:Visibility.Visible;
        if(row!=null){Find<Border>("SocialDetailBadge").Background=row.StatusFill;Find<TextBlock>("SocialState").Foreground=row.StatusInk;}
        Find<TextBlock>("SocialDetailEmpty").Visibility=row==null?Visibility.Visible:Visibility.Collapsed;
        bool hasChat=row!=null&&!string.IsNullOrEmpty(row.Chat)&&(row.Chat.StartsWith("group:")||row.Chat.StartsWith("private:"));
        bool chat=hasChat&&(section==0||section==1),session=hasChat&&section==7;
        Find<Button>("SocialProfile").Visibility=chat?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialBlock").Visibility=chat&&row.Status!="已屏蔽"?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialUnblock").Visibility=chat&&row.Status=="已屏蔽"?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialReset").Visibility=chat||session?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialSave").Visibility=row!=null&&(interest||(section==3&&row.Status.StartsWith("仅本地"))||(section==9&&row.Status=="等待判断"))?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialSave").Content=section==3?"存入 QQ 收藏":section==9?"推迟一小时":"保存兴趣主题";
        Find<Button>("SocialDelete").Visibility=row!=null&&(new[]{3,4,10}.Contains(section)||(section==9&&new[]{"等待判断","执行中"}.Contains(row.Status)))?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialDelete").Content=section==9?"取消想法":section==10?"删除兴趣":section==4?"取消提醒":section==3?(row!=null&&row.Status.StartsWith("QQ收藏")?"从 QQ 收藏移除":"删除本地记录"):"删除记录";
        Find<Border>("SocialDangerActions").Visibility=new[]{"SocialBlock","SocialReset","SocialDelete"}.Any(name=>Find<Button>(name).Visibility==Visibility.Visible)?Visibility.Visible:Visibility.Collapsed;
        Find<StackPanel>("SocialActionPanel").Visibility=new[]{"SocialProfile","SocialSave","SocialBlock","SocialUnblock","SocialReset","SocialDelete"}.Any(name=>Find<Button>(name).Visibility==Visibility.Visible)?Visibility.Visible:Visibility.Collapsed;
        loading=false;
    }
    static void VerifyActivityInteraction() {
        var nav=Find<ComboBox>("SocialSection");
        if(nav.Items.Cast<ActivityCategory>().Any(item=>item.Key=="memories"||item.Key=="lexicon")||nav.Items.Groups==null||nav.Items.Groups.Count!=3)throw new Exception("活动分类仍有重复的记忆入口，或未按用途分组");
        int section=SocialSection;MainPage page=SelectedPage;bool wasLoading=loading;
        try {
            foreach(int target in new[]{0,1,3,4,5,6,7,8,11,13}) {
                loading=true;SocialSection=target;
                ShowActivityDetail(new SocialRow{Id="context-fixture",Chat="group:30001",Name="示例会话",Status="完成",Detail="查看当前记录与对应操作。",Text="",Time=""});
                bool chat=target==0||target==1;
                if((Find<Button>("SocialProfile").Visibility==Visibility.Visible)!=chat||(Find<Button>("SocialBlock").Visibility==Visibility.Visible)!=chat||(Find<Button>("SocialReset").Visibility==Visibility.Visible)!=(chat||target==7))throw new Exception("记录详情显示了无关的会话管理操作");
                if(target==0)Capture(System.IO.Path.Combine(root,"activity-context-actions.png"),MainPage.Activity);
                if(new[]{5,6,8,11,13}.Contains(target)&&Find<StackPanel>("SocialActionPanel").Visibility!=Visibility.Collapsed)throw new Exception("只读运行记录显示了无关操作");
            }
        } finally {loading=true;SocialSection=section;ShowActivityDetail(socialSelection);loading=wasLoading;SelectedPage=page;}
    }
}
