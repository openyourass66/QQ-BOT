using System;
using System.IO;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Windows;

class Launcher
{
    [STAThread] static int Main(string[] args){
        string root=AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        try{
            if(args.Length!=0)throw new Exception("请使用安装工具管理程序；启动器不接受额外命令。");
            if(File.Exists(Path.Combine(root,".install-journal.json")))throw new Exception("上次安装升级未收尾，请打开安装升级工具处理上次中断。");
            var state=PackageTrust.Object(PackageTrust.Read(Path.Combine(root,"install-state.json"),131072));if(Convert.ToString(state["appId"])!="whale-workbench"||Convert.ToInt32(state["formatVersion"])!=1)throw new Exception("安装状态无效。");
            var current=(System.Collections.Generic.Dictionary<string,object>)state["current"];string id=Convert.ToString(current["id"]),data=Path.GetFullPath(Convert.ToString(state["dataRoot"]));if(!Regex.IsMatch(id,@"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"))throw new Exception("安装路径记录无效。");
            string directory=Path.Combine(root,"releases",id);PackageTrust.Verify(directory);if(PackageTrust.Hash(Path.Combine(directory,"release-integrity.json"))!=Convert.ToString(current["manifestSha256"]))throw new Exception("安装版本记录与文件不一致。");if(File.Exists(Path.Combine(data,".upgrade-journal.json")))throw new Exception("数据实例仍有升级中断，请先在安装工具处理。");
            Process.Start(new ProcessStartInfo(Path.Combine(directory,"QQ-BOT.exe"),"--data-dir \""+data.Replace("\"","")+"\""){WorkingDirectory=directory,UseShellExecute=false,CreateNoWindow=true});return 0;
        }catch(Exception error){MessageBox.Show(error.Message,"小鲸工作台暂时无法启动",MessageBoxButton.OK,MessageBoxImage.Warning);return 1;}
    }
}
