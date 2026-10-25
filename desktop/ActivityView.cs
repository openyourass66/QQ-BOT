using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

partial class App
{
    static bool socialBusy;
    static int visibleSocialSection;
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
        Find<Button>("SocialRefresh").Click+=(s,e)=>SocialRequest();
        Find<Button>("SocialContacts").Click+=(s,e)=>SocialRequest("refresh_contacts");
        Find<Button>("SocialBlock").Click+=(s,e)=>SocialRequest("block");
        Find<Button>("SocialUnblock").Click+=(s,e)=>SocialRequest("block",false);
        Find<Button>("SocialSave").Click+=(s,e)=>{if(Find<ComboBox>("SocialSection").SelectedIndex==2){if(socialSelection!=null)OpenFriendMemory(socialSelection.Id);}else SocialRequest(Find<ComboBox>("SocialSection").SelectedIndex==3?"collect_sticker":Find<ComboBox>("SocialSection").SelectedIndex==9?"defer_thought":"edit_interest");};
        Find<Button>("SocialDelete").Click+=(s,e)=>SocialRequest("delete");
        Find<Button>("SocialReset").Click+=(s,e)=>SocialRequest("reset_session");
        Find<Button>("SocialProfile").Click+=(s,e)=>EditProfile();
        Find<TextBox>("SocialSearch").KeyDown+=(s,e)=>{if(e.Key==Key.Enter){e.Handled=true;SocialRequest();}if(e.Key==Key.Escape){Find<TextBox>("SocialSearch").Clear();e.Handled=true;}};
        Find<ComboBox>("SocialSection").SelectionChanged+=(s,e)=>{
            if(loading)return;
            if(!DiscardMemoryEdit()){loading=true;Find<ComboBox>("SocialSection").SelectedIndex=visibleSocialSection;loading=false;return;}
            visibleSocialSection=Find<ComboBox>("SocialSection").SelectedIndex;
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
        Find<Button>("SocialRefresh").Content=busy?"读取中…":Find<ComboBox>("SocialSection").SelectedIndex==3?"刷新 QQ 收藏":"刷新列表";
    }
    static void RenderActivity(Dictionary<string,object> message) {
        if(profileDialog!=null&&message.ContainsKey("op")&&(string)message["op"]=="profile")profileDialog.Close();
        loading=true;RenderSettingsStatus(message);
        var rows=new List<SocialRow>();
        foreach(Dictionary<string,object> row in (IEnumerable)message["rows"])rows.Add(new SocialRow {Id=(string)row["id"],Chat=(string)row["chat"],Name=(string)row["name"],Summary=(string)row["summary"],Status=(string)row["status"],Time=(string)row["time"],Detail=(string)row["detail"],Text=(string)row["text"]});
        Find<ListView>("SocialList").ItemsSource=rows;socialSelection=null;
        Find<TextBlock>("SocialCount").Text=((ComboBoxItem)Find<ComboBox>("SocialSection").SelectedItem).Content+"  ·  "+Convert.ToString(message["total"])+" 条";
        Find<TextBlock>("SocialNote").Text=visibleSocialSection==2?"只读记录 · 内容在人设与记忆中编辑":visibleSocialSection==3?Convert.ToString(message["note"]):rows.Count>0?"按需刷新 · 时间为上海时间":"暂无记录";
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
            var quota=(Dictionary<string,object>)message["quotas"];var quotaRows=((IEnumerable)quota["rows"]).Cast<Dictionary<string,object>>();
            Find<TextBlock>("SettingsQuota").Text=(sameSettings?"":"机器人仍使用另一份配置，请重新启动。\n")+"今日额度（"+quota["date"]+"，"+((bool)quota["live"]?"运行中快照":"离线记录")+"）："+string.Join(" · ",quotaRows.Take(6).Select(q=>q["label"]+" "+q["used"]+"/"+q["limit"]+"，剩余 "+q["remaining"]));
            Find<TextBlock>("SettingsQuota").ToolTip=string.Join("\n",quotaRows.Select(q=>q["label"]+"：已用 "+q["used"]+"，上限 "+q["limit"]+"，剩余 "+q["remaining"]));
        }
        loading=wasLoading;settingsStatusBusy=false;Find<Button>("SettingsRefresh").Content="刷新额度";Find<Button>("SettingsRefresh").IsEnabled=!socialBusy;
        if(!loading)ReconcileDirtySettings();
    }
    static void ShowActivityDetail(SocialRow row) {
        bool memory=Find<ComboBox>("SocialSection").SelectedIndex==10;
        loading=true;
        int section=Find<ComboBox>("SocialSection").SelectedIndex;
        var editor=Find<TextBox>("SocialDetail");editor.IsReadOnly=!memory;
        editor.Text=row==null?"":memory?row.Text:row.Detail;
        editor.Background=memory?Color("#FAFBFE"):Brushes.Transparent;editor.BorderThickness=memory?new Thickness(1):new Thickness(0);editor.Padding=memory?new Thickness(12):new Thickness(0);
        Find<TextBlock>("SocialDetailTitle").Text=row==null?"尚未选择记录":row.Name;
        Find<TextBlock>("SocialDetailMeta").Text=row==null?"选择左侧一条记录查看详情。":row.ChatLabel+(string.IsNullOrEmpty(row.Time)?"":"\n"+row.Time);
        Find<TextBlock>("SocialState").Text=row==null?"":row.Status;
        Find<Border>("SocialDetailBadge").Visibility=row==null?Visibility.Collapsed:Visibility.Visible;
        if(row!=null){Find<Border>("SocialDetailBadge").Background=row.StatusFill;Find<TextBlock>("SocialState").Foreground=row.StatusInk;}
        Find<TextBlock>("SocialDetailEmpty").Visibility=row==null?Visibility.Visible:Visibility.Collapsed;
        bool chat=row!=null&&!string.IsNullOrEmpty(row.Chat)&&row.Chat.Contains(":")&&section<9&&section!=2;
        Find<Button>("SocialProfile").Visibility=chat?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialBlock").Visibility=chat&&row.Status!="已屏蔽"?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialUnblock").Visibility=chat&&row.Status=="已屏蔽"?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialReset").Visibility=chat?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialSave").Visibility=row!=null&&(memory||section==2||(section==3&&row.Status.StartsWith("仅本地"))||(section==9&&row.Status=="等待判断"))?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialSave").Content=section==2?"前往编辑长期记忆":section==3?"存入 QQ 收藏":section==9?"推迟一小时":"保存兴趣主题";
        Find<Button>("SocialDelete").Visibility=row!=null&&(new[]{3,4,10}.Contains(section)||(section==9&&new[]{"等待判断","执行中"}.Contains(row.Status)))?Visibility.Visible:Visibility.Collapsed;
        Find<Button>("SocialDelete").Content=section==9?"取消想法":section==10?"删除兴趣":section==4?"取消提醒":section==3?(row!=null&&row.Status.StartsWith("QQ收藏")?"从 QQ 收藏移除":"删除本地记录"):"删除记忆";
        Find<StackPanel>("SocialActionPanel").Visibility=row!=null&&(chat||new[]{2,3,4,9,10}.Contains(section))?Visibility.Visible:Visibility.Collapsed;
        loading=false;
    }
}
