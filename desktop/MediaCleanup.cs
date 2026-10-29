using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class MediaCleanup
{
    [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
    [StructLayout(LayoutKind.Sequential)] struct Disposition {public byte Delete;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder name,uint length,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,ref Disposition info,uint length);
    static readonly JavaScriptSerializer json=new JavaScriptSerializer {MaxJsonLength=131072};
    static void Reply(object value){Console.WriteLine(json.Serialize(value));Console.Out.Flush();}
    static object Keep(string reason){return new {status="kept",reason=reason};}
    static string FinalPath(SafeFileHandle file){var text=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(file,text,(uint)text.Capacity,0);if(size==0||size>=text.Capacity)throw new IOException();return text.ToString();}
    static double Written(FileInfo info){long value=((long)(uint)info.Written.dwHighDateTime<<32)|(uint)info.Written.dwLowDateTime;return (value-116444736000000000L)/10000.0;}
    static object Run(Dictionary<string,object> request)
    {
        string root=Path.GetFullPath(Convert.ToString(request["root"])),name=Convert.ToString(request["name"]);
        long expected=Convert.ToInt64(request["size"]);double cutoff=Convert.ToDouble(request["cutoff"]);
        if(!Regex.IsMatch(root,@"^[a-zA-Z]:\\")||root.StartsWith(@"\\")||!Regex.IsMatch(name,@"\A[a-fA-F0-9]{64}(?:-\d{2})?\.[a-zA-Z0-9]{1,10}\z")||expected<0||expected>50000000||Double.IsNaN(cutoff)||Double.IsInfinity(cutoff)||cutoff<=0)return Keep("invalid");
        string target=Path.Combine(root,name),final=@"\\?\"+target;
        using(var handle=CreateFile(final,0x80000000|0x00010000,0,IntPtr.Zero,3,0x00200000|0x08000000,IntPtr.Zero))
        {
            if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();return error==2||error==3?(object)new {status="missing"}:Keep(error==32||error==33?"busy":"access");}
            FileInfo info;
            if(!GetFileInformationByHandle(handle,out info)||(info.Attributes&(0x10|0x400))!=0||info.Links!=1)return Keep("links-or-type");
            long length=((long)info.SizeHigh<<32)|info.SizeLow;
            if(length!=expected||Written(info)>cutoff)return Keep("changed");
            if(!String.Equals(FinalPath(handle),final,StringComparison.OrdinalIgnoreCase))return Keep("path");
            using(var stream=new FileStream(handle,FileAccess.Read,65536,false))
            using(var hash=SHA256.Create())
            {
                string digest=BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
                if(digest!=name.Substring(0,64).ToLowerInvariant())return Keep("content");
                Reply(new {status="ready"});
                // Closing stdin or losing the parent before this explicit command preserves the file.
                if(Console.ReadLine()!="delete")return Keep("cancelled");
                if(!GetFileInformationByHandle(handle,out info)||info.Links!=1||!String.Equals(FinalPath(handle),final,StringComparison.OrdinalIgnoreCase))return Keep("changed");
                var disposition=new Disposition {Delete=1};
                if(!SetFileInformationByHandle(handle,4,ref disposition,1))return Keep("access");
            }
        }
        return new {status="deleted"};
    }
    static int Main(string[] args)
    {
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        try{
            int pid;if(args.Length!=1||!Int32.TryParse(args[0],out pid)||pid<=0)return 2;
            var owner=Process.GetProcessById(pid);var watch=new Thread(()=>{try{owner.WaitForExit();}catch{}finally{Environment.Exit(1);}});watch.IsBackground=true;watch.Start();
            string line=Console.ReadLine();if(line==null||line.Length>131072)return 2;
            Reply(Run(json.Deserialize<Dictionary<string,object>>(line)));return 0;
        }catch{Reply(new {status="kept",reason="unverified"});return 1;}
    }
}
