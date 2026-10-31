using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

partial class App
{
    public class KnowledgeRow {
        public string Key, Id, Kind, Revision, Text, Chat;
        public string Name { get; set; }
        public string Meta { get; set; }
        public string Summary { get; set; }
        public bool IsNew, Loaded;
    }
    class KnowledgeDraft { public string Name, Text, Revision, OriginalText, OriginalName; }
    public class PersonaOption { public string Id { get; set; } public string Name { get; set; } public string Text { get; set; } }
    static Dictionary<string,KnowledgeRow> knowledgeItems = new Dictionary<string,KnowledgeRow>();
    static Dictionary<string,KnowledgeDraft> knowledgeDrafts = new Dictionary<string,KnowledgeDraft>();
    static string[] knowledgeSelections = { "global", "", "", "" };
    static KnowledgeRow knowledgeSelection;
    static Dictionary<string,object> knowledgeSnapshot;
    static string knowledgeWorkspace, knowledgePendingKey, knowledgeMemoryTarget, knowledgeRequestedMemory;
    static bool knowledgeLoading, knowledgeBusy;
    static readonly string[] knowledgeCategories = { "人设库", "群友记忆", "工作区记忆", "群内用语" };
    static int KnowledgePage {
        get { return Math.Max(0,Array.IndexOf(knowledgeCategories,Find<ListBox>("KnowledgeNav").SelectedItem as string)); }
        set { Find<ListBox>("KnowledgeNav").SelectedItem=knowledgeCategories[value]; }
    }
    static string KnowledgeSection(string key) { return key=="global"?"persona":"knowledge:"+key; }
    static string ShortText(string text) { return (text??"").Replace("\r"," ").Replace("\n"," "); }
    static void InitKnowledgeView() {
        var nav=Find<ListBox>("KnowledgeNav");nav.ItemsSource=new[]{knowledgeCategories[0],knowledgeCategories[1],knowledgeCategories[3],knowledgeCategories[2]};
        nav.SelectionChanged+=(s,e)=>{if(knowledgeLoading)return;Find<TextBox>("KnowledgeSearch").Clear();RefreshKnowledgeList();if(KnowledgePage==1||KnowledgePage==3)RequestKnowledgeMemories();};nav.SelectedIndex=0;
        Find<ListView>("KnowledgeList").SelectionChanged+=(s,e)=>{if(knowledgeLoading)return;ShowKnowledge(Find<ListView>("KnowledgeList").SelectedItem as KnowledgeRow);};
        Find<TextBox>("KnowledgeSearch").TextChanged+=(s,e)=>{if(!knowledgeLoading)RefreshKnowledgeList();};
        Find<TextBox>("KnowledgeSearch").KeyDown+=(s,e)=>{if(e.Key==Key.Enter){e.Handled=true;if(KnowledgePage==1||KnowledgePage==3)RequestKnowledgeMemories();else if(KnowledgePage==2)RequestKnowledge(new {op="list",workspace=knowledgeWorkspace,query=Find<TextBox>("KnowledgeSearch").Text});else RefreshKnowledgeList();}else if(e.Key==Key.Escape){Find<TextBox>("KnowledgeSearch").Clear();if(KnowledgePage==1||KnowledgePage==3)RequestKnowledgeMemories();else if(KnowledgePage==2)RequestKnowledge(new {op="list",workspace=knowledgeWorkspace});e.Handled=true;}};
        Find<Button>("KnowledgeRefresh").Click+=(s,e)=>{if(KnowledgePage==1||KnowledgePage==3)RequestKnowledgeMemories();else RequestKnowledge(new {op="list",workspace=knowledgeWorkspace,query=KnowledgePage==2?Find<TextBox>("KnowledgeSearch").Text:""});};
        Find<Button>("LockMemory").Click+=(s,e)=>RequestKnowledgeMemories("lock_memory");
        Find<Button>("RestoreMemory").Click+=(s,e)=>RequestKnowledgeMemories(KnowledgePage==3?"restore_lexicon":"restore_memory");
        Find<Button>("ActivateLexicon").Click+=(s,e)=>RequestKnowledgeMemories("activate_lexicon");
        Find<Button>("DisableLexicon").Click+=(s,e)=>RequestKnowledgeMemories("disable_lexicon");
        Find<Button>("ReviewMemory").Click+=(s,e)=>RequestKnowledgeMemories("review_memory");
        Find<Button>("KnowledgeSources").Click+=(s,e)=>{if(knowledgeSelection==null)return;var dialog=new Window{Title="来源与版本",Owner=window,Width=620,Height=500,WindowStartupLocation=WindowStartupLocation.CenterOwner};dialog.Content=new TextBox{Text=knowledgeSelection.Revision??"暂无来源记录",IsReadOnly=true,TextWrapping=TextWrapping.Wrap,AcceptsReturn=true,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Margin=new Thickness(18)};dialog.ShowDialog();};
        Find<Button>("KnowledgeNew").Click+=(s,e)=>NewKnowledge();
        Find<Button>("SavePersona").Click+=(s,e)=>SaveKnowledge();
        Find<Button>("ApplyPersona").Click+=(s,e)=>{if(knowledgeSelection!=null)RequestKnowledge(new {op="apply_preset",workspace=knowledgeWorkspace,id=knowledgeSelection.Id,revision=knowledgeSnapshot["globalRevision"]});};
        Find<Button>("CopyPersona").Click+=(s,e)=>{if(knowledgeSelection==null||knowledgeBusy)return;string text=Find<TextBox>("Persona").Text,name=knowledgeSelection.Kind=="global"?"自定义人设":Find<TextBox>("KnowledgeName").Text+"副本";NewKnowledge();Find<TextBox>("KnowledgeName").Text=name;Find<TextBox>("Persona").Text=text;};
        Find<Button>("DeleteKnowledge").Click+=(s,e)=>DeleteKnowledge();
        Find<Button>("DiscardKnowledge").Click+=(s,e)=>{
            if(knowledgeSelection==null)return;string key=knowledgeSelection.Key;
            knowledgeDrafts.Remove(key);dirtySections.Remove(KnowledgeSection(key));
            if(knowledgeSelection.IsNew){knowledgeItems.Remove(key);knowledgeSelections[KnowledgePage]="";}
            UpdateDirtySummary();RefreshKnowledgeList();
        };
        Find<TextBox>("KnowledgeName").TextChanged+=(s,e)=>KnowledgeEdited();Find<TextBox>("Persona").TextChanged+=(s,e)=>KnowledgeEdited();
    }
    static void UpdateDirtySummary() {dirty=dirtySections.Count>0;Find<TextBlock>("SaveState").Text=dirty?"有尚未保存的修改":"所有修改已保存";}
    static void SetKnowledgeBusy(bool busy) {
        knowledgeBusy=busy;Find<ListBox>("KnowledgeNav").IsEnabled=!busy;Find<ListView>("KnowledgeList").IsEnabled=!busy;
        Find<TextBox>("KnowledgeSearch").IsEnabled=!busy;Find<Button>("KnowledgeRefresh").IsEnabled=!busy;Find<Button>("KnowledgeNew").IsEnabled=!busy;
        Find<TextBox>("KnowledgeName").IsEnabled=!busy&&knowledgeSelection!=null;Find<TextBox>("Persona").IsEnabled=!busy&&knowledgeSelection!=null;
        Find<Button>("KnowledgeRefresh").Content=busy?"读取中…":"刷新列表";UpdateKnowledgeActions();
    }
    static void KnowledgeError(string text) {Find<TextBlock>("KnowledgeError").Text=text;Find<TextBlock>("KnowledgeError").Visibility=string.IsNullOrEmpty(text)?Visibility.Collapsed:Visibility.Visible;}
    static void RequestKnowledge(object data) {
        if(knowledgeBusy)return;knowledgePendingKey=knowledgeSelection==null?null:knowledgeSelection.Key;SetKnowledgeBusy(true);KnowledgeError("");Send("knowledge",data);
    }
    static void RequestKnowledgeMemories(string op="list") {
        if(knowledgeBusy)return;var row=knowledgeSelection;
        if(op!="list"&&(row==null||(row.Kind!="memory"&&row.Kind!="lexicon")))return;
        knowledgePendingKey=row==null?null:row.Key;SetKnowledgeBusy(true);KnowledgeError("");
        KnowledgeDraft draft;knowledgeDrafts.TryGetValue(row==null?"":row.Key,out draft);
        string section=KnowledgePage==3?"lexicon":"memories";
        if(op=="list") {knowledgeRequestedMemory=knowledgeMemoryTarget;Send("memory",new {op=op,query=Find<TextBox>("KnowledgeSearch").Text,section=section,id=knowledgeMemoryTarget??""});knowledgeMemoryTarget=null;}
        else Send("memory",new {op=op,query=Find<TextBox>("KnowledgeSearch").Text,section=section,id=row.Id,chat=row.Chat??"",text=op=="edit_memory"||op=="edit_lexicon"?Find<TextBox>("Persona").Text:"",expectedText=draft==null?row.Text:draft.OriginalText});
    }
    static void OpenFriendMemory(string id) {
        if(knowledgeBusy){Feedback("人设与记忆正在读取，请稍后再打开。");return;}
        knowledgeLoading=true;KnowledgePage=1;Find<TextBox>("KnowledgeSearch").Clear();knowledgeLoading=false;
        if(!string.IsNullOrEmpty(id))knowledgeSelections[1]="memory:"+id;
        knowledgeMemoryTarget=id;SelectedPage=MainPage.Knowledge;RefreshKnowledgeList();RequestKnowledgeMemories();
    }
    static void RenderKnowledge(Dictionary<string,object> data) {
        knowledgeSnapshot=data;knowledgeWorkspace=(string)data["workspace"];
        string op=data.ContainsKey("op")?(string)data["op"]:"list";
        if(op!="list"&&op!="read_memory"&&knowledgePendingKey!=null) {knowledgeDrafts.Remove(knowledgePendingKey);dirtySections.Remove(KnowledgeSection(knowledgePendingKey));if(knowledgeItems.ContainsKey(knowledgePendingKey)&&knowledgeItems[knowledgePendingKey].IsNew)knowledgeItems.Remove(knowledgePendingKey);}
        var previous=knowledgeItems;knowledgeItems=previous.Where(pair=>pair.Value.Kind=="memory"||pair.Value.Kind=="lexicon"||pair.Value.IsNew||knowledgeDrafts.ContainsKey(pair.Key)).ToDictionary(pair=>pair.Key,pair=>pair.Value);
        string global=(string)data["global"];
        knowledgeItems["global"]=new KnowledgeRow {Key="global",Kind="global",Id="",Name="当前全局人设",Meta="未指定专属人设的会话沿用此项",Summary=ShortText(global),Text=global,Revision=data["globalRevision"] as string,Loaded=true};
        foreach(Dictionary<string,object> preset in (IEnumerable)data["presets"]) {
            string id=(string)preset["id"],key="preset:"+id,text=(string)preset["text"];
            knowledgeItems[key]=new KnowledgeRow {Key=key,Kind="preset",Id=id,Name=(string)preset["name"],Meta="已保存的人设 · 可供会话选择",Summary=ShortText(text),Text=text,Loaded=true};
        }
        foreach(Dictionary<string,object> file in (IEnumerable)data["files"]) {
            string name=(string)file["name"],key="file:"+name;
            knowledgeItems[key]=new KnowledgeRow {Key=key,Kind="file",Id=name,Name=name,Meta="工作区记忆 · "+Convert.ToInt64(file["size"])+" 字节",Summary=file.ContainsKey("preview")&&!string.IsNullOrEmpty(file["preview"] as string)?(string)file["preview"]:"点击查看和编辑文件内容"};
        }
        if(data.ContainsKey("file")) {
            var file=(Dictionary<string,object>)data["file"];KnowledgeRow row;
            if(knowledgeItems.TryGetValue("file:"+(string)file["name"],out row)){row.Text=(string)file["text"];row.Revision=(string)file["revision"];row.Loaded=true;row.Summary=ShortText(row.Text);}
        }
        if(data.ContainsKey("selectedKey")) {string selected=(string)data["selectedKey"];if(op=="apply_preset"){knowledgeLoading=true;KnowledgePage=0;knowledgeLoading=false;}knowledgeSelections[KnowledgePage]=selected;}
        SetKnowledgeBusy(false);UpdateDirtySummary();RefreshKnowledgeList();
        if(data.ContainsKey("error"))KnowledgeError((string)data["error"]);
        else if(data.ContainsKey("warning")) {KnowledgeError((string)data["warning"]);if(op!="list"&&op!="read_memory")Feedback("当前内容已保存；部分其他记录暂不可用，请查看行内提示。");}
        else if(op!="list"&&op!="read_memory")Feedback(op=="apply_preset"||op=="save_global"?"全局人设已保存，新会话生效。":"人设与记忆已保存，其他草稿继续保留。");
    }
    static void RenderKnowledgeMemories(Dictionary<string,object> message) {
        string op=(string)message["op"];
        if(op!="list"&&knowledgePendingKey!=null){knowledgeDrafts.Remove(knowledgePendingKey);dirtySections.Remove(KnowledgeSection(knowledgePendingKey));}
        string kind=message.ContainsKey("section")&&(string)message["section"]=="lexicon"?"lexicon":"memory";
        knowledgeItems=knowledgeItems.Where(pair=>pair.Value.Kind!=kind||knowledgeDrafts.ContainsKey(pair.Key)).ToDictionary(pair=>pair.Key,pair=>pair.Value);
        foreach(Dictionary<string,object> item in (IEnumerable)message["rows"]) {
            string id=(string)item["id"],chat=(string)item["chat"],key=kind+":"+id;
            knowledgeItems[key]=new KnowledgeRow {Key=key,Kind=kind,Id=id,Chat=chat,Name=(string)item["name"],Meta=(chat.StartsWith("group:")?"群 "+chat.Substring(6):"好友 "+chat.Substring(8))+" · "+(string)item["status"],Summary=(string)item["summary"],Text=(string)item["text"],Revision=(string)item["detail"],Loaded=true};
        }
        if(op=="list"&&!string.IsNullOrEmpty(knowledgeRequestedMemory)){knowledgeSelections[1]="memory:"+knowledgeRequestedMemory;knowledgeRequestedMemory=null;}
        SetKnowledgeBusy(false);UpdateDirtySummary();RefreshKnowledgeList();Feedback(op=="list"?"群友记忆已更新。":"群友记忆已保存。");
    }
    static void RefreshKnowledgeList() {
        string kind=KnowledgePage==0?"preset":KnowledgePage==1?"memory":KnowledgePage==3?"lexicon":"file",query=Find<TextBox>("KnowledgeSearch").Text.Trim();
        var rows=knowledgeItems.Values.Where(row=>(row.Kind==kind||KnowledgePage==0&&row.Kind=="global")&&(query.Length==0||(row.Name+" "+row.Meta+" "+row.Summary+" "+row.Revision+" "+row.Text+" "+(knowledgeDrafts.ContainsKey(row.Key)?knowledgeDrafts[row.Key].Name+" "+knowledgeDrafts[row.Key].Text:"")).IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0)).OrderBy(row=>row.Kind=="global"?0:row.IsNew?1:2).ThenBy(row=>row.Name).ToList();
        knowledgeLoading=true;Find<ListView>("KnowledgeList").ItemsSource=rows;
        var selected=rows.FirstOrDefault(row=>row.Key==knowledgeSelections[KnowledgePage])??rows.FirstOrDefault();Find<ListView>("KnowledgeList").SelectedItem=selected;knowledgeLoading=false;
        Find<TextBlock>("KnowledgeCount").Text=knowledgeCategories[KnowledgePage]+" · "+rows.Count+" 项";
        string status=KnowledgePage==0?"切换条目保留草稿 · 会话可选择已保存的人设":KnowledgePage==1?"名字、QQ、群号或内容 · 回车搜索全部记忆":KnowledgePage==3?"仅在来源群使用 · 确认后生效 · 支持纠正与停用":"支持子目录 · 回车搜索文件内容 · 切换条目保留草稿";
        if(KnowledgePage==2&&connectionMode=="remote")status="远程模式：在页面内浏览和编辑服务器记忆文件 · 支持子目录 · 回车搜索文件内容";
        Find<TextBlock>("KnowledgeStatus").Text=status;
        Find<Button>("KnowledgeNew").Visibility=KnowledgePage==1||KnowledgePage==3?Visibility.Collapsed:Visibility.Visible;Find<Button>("KnowledgeNew").Content=KnowledgePage==0?"新建人设":"新建记忆文件";
        Find<Button>("Memory").Visibility=connectionMode!="remote"&&KnowledgePage==2?Visibility.Visible:Visibility.Collapsed;
        Find<TextBlock>("KnowledgeEmpty").Visibility=rows.Count==0?Visibility.Visible:Visibility.Collapsed;
        Find<TextBlock>("KnowledgeEmpty").Text=query.Length>0?"没有匹配的记录\n可按回车搜索更多内容":KnowledgePage==3?"还没有群内用语\n开启指定群的用语学习后，候选会出现在这里":KnowledgePage==1?"还没有群友记忆\n开启长期记忆并与小鲸互动后会出现在这里":"还没有记忆文件\n点击“新建记忆文件”开始记录";
        ShowKnowledge(selected);
    }
    static void ShowKnowledge(KnowledgeRow row) {
        knowledgeSelection=row;if(row!=null)knowledgeSelections[KnowledgePage]=row.Key;
        KnowledgeDraft draft=null;if(row!=null)knowledgeDrafts.TryGetValue(row.Key,out draft);
        knowledgeLoading=true;
        Find<TextBlock>("KnowledgeDetailTitle").Text=row==null?"选择一条记录":row.Kind=="global"?"当前全局人设":row.IsNew?(row.Kind=="file"?"新建记忆文件":"新建自定义人设"):row.Name;
        Find<TextBox>("KnowledgeName").Text=draft!=null?draft.Name:row==null?"":row.Name;
        Find<TextBox>("KnowledgeName").IsReadOnly=row==null||row.Kind=="global"||row.Kind=="memory"||row.Kind=="lexicon"||row.Kind=="file"&&!row.IsNew;
        Find<StackPanel>("KnowledgeNamePanel").Visibility=row!=null&&(row.Kind=="preset"||row.Kind=="file"&&row.IsNew)?Visibility.Visible:Visibility.Collapsed;
        Find<TextBox>("KnowledgeName").MaxLength=row!=null&&row.Kind=="file"?200:64;
        Find<TextBlock>("KnowledgeNameLabel").Text=row!=null&&row.Kind=="file"?"文件名（.md / .txt，可填写子目录）":"名称";
        Find<TextBox>("KnowledgeName").Tag=row!=null&&row.Kind=="file"?"例如 notes.md 或 people/friend.md":"为这套人设起一个名字";
        string contentLabel=row!=null&&row.Kind=="memory"?"记忆内容":row!=null&&row.Kind=="lexicon"?"词条含义":row!=null&&row.Kind=="file"?"文件内容":"人设内容";
        Find<TextBlock>("KnowledgeContentLabel").Text=contentLabel;System.Windows.Automation.AutomationProperties.SetName(Find<TextBox>("Persona"),contentLabel);
        Find<TextBox>("Persona").MaxLength=row==null?100000:row.Kind=="preset"?10000:row.Kind=="memory"?2000:row.Kind=="lexicon"?300:100000;
        Find<TextBox>("Persona").Text=draft!=null?draft.Text:row==null?"":row.Text??"";
        Find<TextBlock>("PersonaHint").Text=row==null?"从左侧选择已有记录，或新建人设与记忆文件。":row.Kind=="global"?"用于未指定专属人设的会话。保存后新会话生效，已有会话可重置上下文后使用。":row.Kind=="preset"?"保存后可在“会话人设与参与”中选择。每个会话保存独立副本，修改人设库不会改动已保存的会话。":row.Kind=="memory"?row.Meta+(row.Chat.StartsWith("group:")?" · "+row.Revision.Split('\n')[0]:"")+"\n保存后用于该会话后续的模型上下文。":"工作区 memory 目录中的文本文件；供模型读取，保存文件不会自动重置会话。";
        Find<Button>("SavePersona").Content=row==null?"保存":row.Kind=="global"?"保存全局人设":row.Kind=="preset"?"保存到人设库":row.Kind=="memory"?"保存群友记忆":"保存记忆文件";
        if(row!=null&&row.Kind=="lexicon"){Find<TextBlock>("PersonaHint").Text=row.Meta+" · 仅在来源群使用。候选需确认后生效，可编辑含义、停用或恢复。";Find<Button>("SavePersona").Content="保存词条含义";}
        knowledgeLoading=false;SetKnowledgeBusy(knowledgeBusy);KnowledgeError("");UpdateKnowledgeActions();
        if(row!=null&&row.Kind=="file"&&!row.Loaded&&draft==null&&!knowledgeBusy)RequestKnowledge(new {op="read_memory",workspace=knowledgeWorkspace,name=row.Id,query=Find<TextBox>("KnowledgeSearch").Text});
    }
    static void KnowledgeEdited() {
        if(knowledgeLoading||loading||knowledgeSelection==null||knowledgeBusy)return;var row=knowledgeSelection;
        if(!row.IsNew&&Find<TextBox>("KnowledgeName").Text==row.Name&&Find<TextBox>("Persona").Text==(row.Text??"")) {
            knowledgeDrafts.Remove(row.Key);dirtySections.Remove(KnowledgeSection(row.Key));UpdateDirtySummary();UpdateKnowledgeActions();return;
        }
        KnowledgeDraft draft;if(!knowledgeDrafts.TryGetValue(row.Key,out draft)){draft=new KnowledgeDraft {Revision=row.Revision,OriginalText=row.Text,OriginalName=row.Name};knowledgeDrafts[row.Key]=draft;}
        draft.Name=Find<TextBox>("KnowledgeName").Text;draft.Text=Find<TextBox>("Persona").Text;MarkDirty(KnowledgeSection(row.Key));UpdateKnowledgeActions();
    }
    static void UpdateKnowledgeActions() {
        var row=knowledgeSelection;bool draft=row!=null&&knowledgeDrafts.ContainsKey(row.Key);
        Find<Button>("SavePersona").IsEnabled=!knowledgeBusy&&row!=null&&draft;
        Find<Button>("DeleteKnowledge").Visibility=row!=null&&row.Kind!="global"?Visibility.Visible:Visibility.Collapsed;Find<Button>("DeleteKnowledge").IsEnabled=!knowledgeBusy;
        Find<Button>("DiscardKnowledge").Visibility=draft?Visibility.Visible:Visibility.Collapsed;Find<Button>("DiscardKnowledge").IsEnabled=!knowledgeBusy;
        Find<Button>("ApplyPersona").Visibility=row!=null&&row.Kind=="preset"&&!row.IsNew?Visibility.Visible:Visibility.Collapsed;Find<Button>("ApplyPersona").IsEnabled=!knowledgeBusy&&!draft&&!knowledgeDrafts.ContainsKey("global");
        Find<Button>("CopyPersona").Visibility=row!=null&&(row.Kind=="global"||row.Kind=="preset")?Visibility.Visible:Visibility.Collapsed;Find<Button>("CopyPersona").IsEnabled=!knowledgeBusy;
        bool sourced=row!=null&&(row.Kind=="memory"||row.Kind=="lexicon");
        foreach(string name in new[]{"KnowledgeSources","RestoreMemory","LockMemory","ActivateLexicon","DisableLexicon","ReviewMemory"}){Find<Button>(name).Visibility=sourced&&((name!="LockMemory"&&name!="ReviewMemory")||row.Kind=="memory")&&((name!="ActivateLexicon"&&name!="DisableLexicon")||row.Kind=="lexicon")?Visibility.Visible:Visibility.Collapsed;Find<Button>(name).IsEnabled=!knowledgeBusy&&!draft;}
        if(row!=null&&row.Kind=="lexicon") {Find<Button>("ActivateLexicon").Visibility=row.Meta.EndsWith(" · 有效")?Visibility.Collapsed:Visibility.Visible;Find<Button>("DisableLexicon").Visibility=row.Meta.EndsWith(" · 已停用")?Visibility.Collapsed:Visibility.Visible;}
        Find<Border>("KnowledgeSecondaryBar").Visibility=row!=null?Visibility.Visible:Visibility.Collapsed;
        Find<Border>("KnowledgeDeleteArea").Visibility=Find<Button>("DeleteKnowledge").Visibility;
        Find<Button>("LockMemory").Content=row!=null&&row.Meta.Contains("已锁定")?"解除锁定":"锁定记忆";
        Find<Button>("LockMemory").ToolTip="锁定后保留手动编辑的内容，暂停自动整理这条记忆。";
        Find<TextBlock>("KnowledgeWordCount").Text=(row==null?"":draft?"未保存 · ":"已保存 · ")+Find<TextBox>("Persona").Text.Length+" 字";
    }
    static void NewKnowledge() {
        if(knowledgeBusy||KnowledgePage==1||KnowledgePage==3)return;string kind=KnowledgePage==0?"preset":"file",key=kind+":new-"+Guid.NewGuid().ToString("N");
        var row=new KnowledgeRow {Key=key,Id="",Kind=kind,Name=kind=="preset"?"未命名人设":"未命名文件",Meta="尚未保存的草稿",Summary="填写名称和内容后保存",Text="",IsNew=true,Loaded=true};knowledgeItems[key]=row;
        knowledgeDrafts[key]=new KnowledgeDraft {Name="",Text="",Revision=null,OriginalText=""};knowledgeSelections[KnowledgePage]=key;
        Find<TextBox>("KnowledgeSearch").Clear();MarkDirty(KnowledgeSection(key));RefreshKnowledgeList();Find<TextBox>("KnowledgeName").Focus();
    }
    static void SaveKnowledge() {
        var row=knowledgeSelection;if(row==null||knowledgeBusy)return;KnowledgeDraft draft;knowledgeDrafts.TryGetValue(row.Key,out draft);
        string name=Find<TextBox>("KnowledgeName").Text.Trim(),text=Find<TextBox>("Persona").Text;
        if(row.Kind=="memory"){if(string.IsNullOrWhiteSpace(text)){KnowledgeError("记忆内容不能为空。");return;}RequestKnowledgeMemories("edit_memory");return;}
        if(row.Kind=="lexicon"){if(string.IsNullOrWhiteSpace(text)){KnowledgeError("词条含义不能为空。");return;}RequestKnowledgeMemories("edit_lexicon");return;}
        if(row.Kind=="preset"&&(name.Length==0||string.IsNullOrWhiteSpace(text))){KnowledgeError("请填写人设名称和内容。");return;}
        if(row.Kind=="file"&&name.Length==0){KnowledgeError("请填写 .md 或 .txt 文件名。");return;}
        if(row.Kind=="global")RequestKnowledge(new {op="save_global",workspace=knowledgeWorkspace,text=text,revision=draft==null?row.Revision:draft.Revision});
        else if(row.Kind=="preset")RequestKnowledge(new {op="save_preset",workspace=knowledgeWorkspace,id=row.IsNew?"":row.Id,name=name,text=text,expectedText=draft==null?row.Text:draft.OriginalText,expectedName=draft==null?row.Name:draft.OriginalName,libraryRevision=knowledgeSnapshot["libraryRevision"]});
        else RequestKnowledge(new {op="save_memory",workspace=knowledgeWorkspace,name=row.IsNew?name:row.Id,text=text,revision=draft==null?row.Revision:draft.Revision,query=Find<TextBox>("KnowledgeSearch").Text});
    }
    static void DeleteKnowledge() {
        var row=knowledgeSelection;if(row==null||knowledgeBusy||row.Kind=="global")return;
        if(MessageBox.Show(window,row.Kind=="preset"?"删除这条人设？已保存的会话人设会保留。":"删除所选记忆？此操作会移除保存的内容。","确认删除",MessageBoxButton.YesNo)!=MessageBoxResult.Yes)return;
        if(row.IsNew){knowledgeItems.Remove(row.Key);knowledgeDrafts.Remove(row.Key);dirtySections.Remove(KnowledgeSection(row.Key));knowledgeSelections[KnowledgePage]="";UpdateDirtySummary();RefreshKnowledgeList();return;}
        if(row.Kind=="memory"||row.Kind=="lexicon"){RequestKnowledgeMemories("delete");return;}
        KnowledgeDraft draft;knowledgeDrafts.TryGetValue(row.Key,out draft);
        if(row.Kind=="preset")RequestKnowledge(new {op="delete_preset",workspace=knowledgeWorkspace,id=row.Id,expectedText=draft==null?row.Text:draft.OriginalText,expectedName=draft==null?row.Name:draft.OriginalName,libraryRevision=knowledgeSnapshot["libraryRevision"]});
        else RequestKnowledge(new {op="delete_memory",workspace=knowledgeWorkspace,name=row.Id,revision=draft==null?row.Revision:draft.Revision,query=Find<TextBox>("KnowledgeSearch").Text});
    }
    static ComboBox AddPersonaPicker(StackPanel panel,TextBox editor,string current) {
        var options=new List<PersonaOption> {new PersonaOption {Id="inherit",Name="沿用全局人设",Text=""},new PersonaOption {Id="custom",Name="自定义本会话人设",Text=current}};
        options.AddRange(knowledgeItems.Values.Where(row=>row.Kind=="preset"&&!row.IsNew).OrderBy(row=>row.Name).Select(row=>new PersonaOption {Id=row.Id,Name=row.Name,Text=row.Text}));
        panel.Children.Add(new TextBlock {Text="从人设库选择",FontSize=12});
        var picker=new ComboBox {ItemsSource=options,DisplayMemberPath="Name",Margin=new Thickness(0,6,0,7)};
        System.Windows.Automation.AutomationProperties.SetName(picker,"选择会话人设");panel.Children.Add(picker);
        panel.Children.Add(new TextBlock {Text="选择后复制到本会话，可继续修改。保存会话后，库内修改不会影响这个副本。",Foreground=Ink("Muted"),FontSize=10,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,8)});
        picker.SelectionChanged+=(s,e)=>{var selected=picker.SelectedItem as PersonaOption;if(selected==null)return;editor.IsEnabled=selected.Id!="inherit";if(selected.Id!="custom")editor.Text=selected.Text;};
        picker.SelectedItem=string.IsNullOrEmpty(current)?options[0]:options.Skip(2).FirstOrDefault(option=>option.Text==current)??options[1];
        return picker;
    }
    static void VerifyKnowledgeInteraction() {
        if(Find<ListBox>("KnowledgeNav").Items.Count!=4||knowledgeItems.Values.Count(row=>row.Kind=="preset")!=2)throw new Exception("人设与记忆初始化不完整");
        var originalItems=new Dictionary<string,KnowledgeRow>(knowledgeItems);var originalSections=new HashSet<string>(dirtySections);
        var friendly=knowledgeItems["preset:preset-friendly"];
        Find<TextBox>("Persona").Text="global draft";
        Find<ListView>("KnowledgeList").SelectedItem=friendly;Find<TextBox>("Persona").Text="preset draft";
        Find<ListView>("KnowledgeList").SelectedItem=knowledgeItems["global"];
        if(Find<TextBox>("Persona").Text!="global draft")throw new Exception("切换人设丢失全局草稿");
        Find<TextBox>("Persona").Text=knowledgeItems["global"].Text;
        if(knowledgeDrafts.ContainsKey("global")||Find<Button>("SavePersona").IsEnabled||Find<StackPanel>("KnowledgeNamePanel").Visibility!=Visibility.Collapsed)throw new Exception("恢复原文后仍有无效草稿或全局名称重复输入");
        Find<TextBox>("Persona").Text="global draft";
        Find<ListView>("KnowledgeList").SelectedItem=friendly;if(Find<TextBox>("Persona").Text!="preset draft")throw new Exception("切换人设丢失库内草稿");
        var panel=new StackPanel();var editor=new TextBox();var picker=AddPersonaPicker(panel,editor,"");
        picker.SelectedItem=((IEnumerable<PersonaOption>)picker.ItemsSource).First(item=>item.Id=="preset-friendly");
        if(editor.Text!=friendly.Text||editor.Text=="preset draft")throw new Exception("会话人设选择没有使用已保存内容");
        editor.Text="conversation copy";if(friendly.Text==editor.Text)throw new Exception("会话编辑改动了库内人设");
        picker.SelectedIndex=0;if(editor.Text!=""||editor.IsEnabled)throw new Exception("会话没有恢复沿用全局人设");
        knowledgeLoading=true;KnowledgePage=2;knowledgeLoading=false;NewKnowledge();
        string fileKey=knowledgeSelection.Key;Find<TextBox>("KnowledgeName").Text="draft.md";Find<TextBox>("Persona").Text="workspace draft";
        KnowledgePage=0;KnowledgePage=2;
        if(knowledgeSelection.Key!=fileKey||Find<TextBox>("Persona").Text!="workspace draft")throw new Exception("切换分类丢失工作区文件草稿");
        Capture(Path.Combine(root,"knowledge-draft.png"),MainPage.Knowledge);
        knowledgeItems=originalItems;knowledgeDrafts.Clear();dirtySections=originalSections;knowledgeSelections=new[]{"global","","",""};
        KnowledgePage=0;UpdateDirtySummary();RefreshKnowledgeList();
        Find<ListView>("KnowledgeList").SelectedItem=knowledgeItems["preset:preset-friendly"];Capture(Path.Combine(root,"knowledge-personas.png"),MainPage.Knowledge);
        double width=window.Width,height=window.Height;window.Width=1000;window.Height=700;Capture(Path.Combine(root,"knowledge-compact.png"),MainPage.Knowledge);window.Width=width;window.Height=height;
        Find<ListView>("KnowledgeList").SelectedItem=knowledgeItems["global"];
    }
}
