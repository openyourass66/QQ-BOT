using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

static class PackageTrust
{
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=6291456,RecursionLimit=40};
    static Exception Invalid(){return new Exception("发行包签名或文件校验未通过，请使用完整的受信发行包。内部未签名包可继续便携试用。");}
    public static Dictionary<string,object> Object(string text){return Json.Deserialize<Dictionary<string,object>>(text);}
    public static string Serialize(object value){return Json.Serialize(value);}
    static IEnumerable<object> Items(object value){var items=value as System.Collections.IEnumerable;if(items==null||value is string)throw Invalid();foreach(object item in items)yield return item;}
    public static void CopyVerified(string source,string destination){var manifest=Verify(source);if(Directory.Exists(destination)||File.Exists(destination))throw Invalid();Directory.CreateDirectory(destination);var files=Items(manifest["files"]).Cast<Dictionary<string,object>>().Select(item=>Convert.ToString(item["path"])).Concat(new[]{"release-integrity.json","release-integrity.sig.json"});foreach(string name in files){string target=Path.Combine(destination,name.Replace('/',Path.DirectorySeparatorChar));Directory.CreateDirectory(Path.GetDirectoryName(target));File.Copy(Path.Combine(source,name.Replace('/',Path.DirectorySeparatorChar)),target,false);}Verify(destination);}
    public static string Read(string path,int maximum){Safe(path);var info=new FileInfo(path);if(info.Length>maximum)throw Invalid();return File.ReadAllText(path,Encoding.UTF8);}
    public static void Safe(string path){for(string current=Path.GetFullPath(path);!String.IsNullOrEmpty(current);current=Path.GetDirectoryName(current)){if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw Invalid();if(Path.GetPathRoot(current)==current)break;}}
    public static string Hash(string path){Safe(path);return HashFile(path);}
    static string HashFile(string path){if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw Invalid();using(var input=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
    static bool Name(string path){return path.Length>0&&path.Length<=2048&&!Regex.IsMatch(path,@"[\\<>:""|?*\x00-\x1f]")&&path.Split('/').All(part=>part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".")&&!part.EndsWith(" ")&&!Regex.IsMatch(part,@"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)",RegexOptions.IgnoreCase));}
    static void Walk(string root,string directory,HashSet<string> files,int depth){if(depth>32)throw Invalid();foreach(string path in Directory.GetFileSystemEntries(directory)){if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw Invalid();string name=path.Substring(root.Length+1).Replace('\\','/');if(!Name(name))throw Invalid();if(Directory.Exists(path)){Walk(root,path,files,depth+1);continue;}if(!files.Add(name)||files.Count>30002)throw Invalid();}}
    public static Dictionary<string,object> Verify(string root){
        root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);Safe(root);string manifestPath=Path.Combine(root,"release-integrity.json"),raw=Read(manifestPath,6291456);byte[] bytes=File.ReadAllBytes(manifestPath);var manifest=Object(raw);var signature=Object(Read(Path.Combine(root,"release-integrity.sig.json"),8192));Dictionary<string,object> trust;
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("release-trust.json")){if(stream==null)throw Invalid();using(var reader=new StreamReader(stream,Encoding.UTF8))trust=Object(reader.ReadToEnd());}
        if(Convert.ToInt32(trust["formatVersion"])!=1||Convert.ToInt32(manifest["formatVersion"])!=1||Convert.ToString(manifest["appId"])!="whale-workbench"||Convert.ToString(manifest["platform"])!="win32-x64")throw Invalid();
        var keys=Items(trust["keys"]);bool verified=false;foreach(Dictionary<string,object> key in keys){if(Convert.ToString(key["id"])!=Convert.ToString(signature["keyId"])||Convert.ToString(key["algorithm"])!="rsa-sha256"||!Items(key["channels"]).Select(Convert.ToString).Contains(Convert.ToString(manifest["channel"])))continue;byte[] modulus=Convert.FromBase64String(Convert.ToString(key["modulus"]));if(modulus.Length<384||modulus.Length>1024||Convert.ToString(key["exponent"])!="AQAB")throw Invalid();using(var rsa=new RSACryptoServiceProvider(new CspParameters(24))){rsa.PersistKeyInCsp=false;rsa.ImportParameters(new RSAParameters {Modulus=modulus,Exponent=new byte[]{1,0,1}});using(var sha=SHA256.Create())verified=rsa.VerifyData(bytes,sha,Convert.FromBase64String(Convert.ToString(signature["signature"])));}if(verified)break;}if(!verified)throw Invalid();
        var actual=new HashSet<string>(StringComparer.OrdinalIgnoreCase);Walk(root,root,actual,0);actual.Remove("release-integrity.json");actual.Remove("release-integrity.sig.json");var expected=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;foreach(Dictionary<string,object> entry in Items(manifest["files"])){string name=Convert.ToString(entry["path"]),digest=Convert.ToString(entry["sha256"]);long size=Convert.ToInt64(entry["size"]);if(!Name(name)||!expected.Add(name)||!Regex.IsMatch(digest,"^[a-f0-9]{64}$")||size<0||size>1073741824||(total+=size)>4294967296L)throw Invalid();string path=Path.Combine(root,name.Replace('/',Path.DirectorySeparatorChar));if(!File.Exists(path)||new FileInfo(path).Length!=size||HashFile(path)!=digest)throw Invalid();}
        foreach(string name in new[]{"QQ-BOT.exe","WhaleSetup.exe","WhaleLauncher.exe","runtime/node.exe","scripts/install-worker.mjs","components/release-trust.json","release-manifest.json"})if(!expected.Contains(name))throw Invalid();
        if(!actual.SetEquals(expected))throw Invalid();return manifest;
    }
}
