using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class ProcessGuard
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint ActiveProcesses;public UIntPtr Affinity;public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Reserved1,Peb,Reserved2a,Reserved2b,Pid,ParentPid;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out ProcessInfo info,uint size,out uint returned);
    class Lease {public IntPtr Job;public Process Process;}
    static readonly Dictionary<int,Lease> leases=new Dictionary<int,Lease>();
    static readonly object sync=new object();
    static readonly JavaScriptSerializer json=new JavaScriptSerializer {MaxJsonLength=8192};
    static int parentPid;
    static void Release(int pid,Lease expected=null) {
        lock(sync){Lease lease;if(!leases.TryGetValue(pid,out lease)||expected!=null&&!Object.ReferenceEquals(lease,expected))return;leases.Remove(pid);CloseHandle(lease.Job);lease.Process.Dispose();}
    }
    static void ReleaseAll(){lock(sync){foreach(var pid in new List<int>(leases.Keys))Release(pid);}}
    static void Assign(int pid) {
        if(pid<=0||pid==parentPid||pid==Process.GetCurrentProcess().Id)throw new Exception("invalid child");
        lock(sync){if(leases.ContainsKey(pid))return;}
        IntPtr process=OpenProcess(0x0100|0x0001|0x0400,false,pid),job=IntPtr.Zero;
        if(process==IntPtr.Zero)throw new Win32Exception();
        try{
            ProcessInfo info;uint returned;
            if(NtQueryInformationProcess(process,0,out info,(uint)Marshal.SizeOf(typeof(ProcessInfo)),out returned)!=0||info.ParentPid.ToInt64()!=parentPid)throw new Exception("not a direct managed child");
            job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
            var limits=new ExtendedLimits();limits.Basic.Flags=0x2000;
            if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))||!AssignProcessToJobObject(job,process))throw new Win32Exception();
            var lease=new Lease {Job=job,Process=Process.GetProcessById(pid)};
            lock(sync){leases.Add(pid,lease);}job=IntPtr.Zero;
            lease.Process.EnableRaisingEvents=true;lease.Process.Exited+=(s,e)=>Release(pid,lease);
            if(lease.Process.HasExited)Release(pid,lease);
        }finally{CloseHandle(process);if(job!=IntPtr.Zero)CloseHandle(job);}
    }
    static void Reply(object value){lock(json){Console.WriteLine(json.Serialize(value));Console.Out.Flush();}}
    static int Main(string[] args) {
        if(args.Length!=1||!Int32.TryParse(args[0],out parentPid)||parentPid<=0)return 2;
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        try{
            var owner=Process.GetProcessById(parentPid);
            var watch=new Thread(()=>{try{owner.WaitForExit();}catch{}finally{ReleaseAll();Environment.Exit(0);}});watch.IsBackground=true;watch.Start();
            Reply(new {type="ready"});string line;
            while((line=Console.ReadLine())!=null){
                string id="";
                try{
                    if(line.Length>4096)throw new Exception();
                    var request=json.Deserialize<Dictionary<string,object>>(line);id=Convert.ToString(request["id"]);string action=Convert.ToString(request["action"]);
                    if(action=="quit"){Reply(new {id=id,ok=true});break;}
                    int pid=Convert.ToInt32(request["pid"]);
                    if(action=="assign")Assign(pid);else if(action=="terminate")Release(pid);else throw new Exception();
                    Reply(new {id=id,ok=true});
                }catch{Reply(new {id=id,ok=false,code="PROCESS_GUARD_FAILED"});}
            }
            return 0;
        }catch{return 1;}finally{ReleaseAll();}
    }
}
