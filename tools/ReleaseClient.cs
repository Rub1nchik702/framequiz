using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public sealed class ReleaseClient {
    public const string ClientId = "Iv23lialknXlPhNjjHsH";
    const string Api = "https://api.github.com/repos/Rub1nchik702/framequiz";
    static readonly HttpClient Http = new HttpClient(new HttpClientHandler { AllowAutoRedirect=false });
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static ReleaseClient() {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("Framequiz-Updater/0.2");
        Http.Timeout = TimeSpan.FromMinutes(4);
    }
    public static async Task<Dictionary<string,object>> OAuth(string endpoint, Dictionary<string,string> fields) {
        using (var req=new HttpRequestMessage(HttpMethod.Post,"https://github.com/login/"+endpoint)) {
            req.Headers.Accept.ParseAdd("application/json");
            req.Content=new FormUrlEncodedContent(fields);
            using(var res=await Http.SendAsync(req)) {
                res.EnsureSuccessStatusCode();
                return Json.Deserialize<Dictionary<string,object>>(await res.Content.ReadAsStringAsync());
            }
        }
    }
    static HttpRequestMessage Request(string url,string token,string accept) {
        var req=new HttpRequestMessage(HttpMethod.Get,url);
        req.Headers.Accept.ParseAdd(accept);
        if(token!=null)req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
        return req;
    }
    public static string Hash(string path) {
        using(var file=File.OpenRead(path))using(var sha=SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();
    }
    public static Task<string> Download(string token,string stage,string installed) {
        return Download(token,stage,installed,CancellationToken.None);
    }
    public static async Task<string> Download(string token,string stage,string installed,CancellationToken cancellation) {
        using(var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation)) {
            deadline.CancelAfter(TimeSpan.FromMinutes(4));
            try {
                return await DownloadRelease(token,stage,installed,deadline.Token);
            } catch(OperationCanceledException) {
                if(cancellation.IsCancellationRequested) throw;
                throw new TimeoutException("GitHub release download timed out.");
            }
        }
    }
    static async Task<string> DownloadRelease(string token,string stage,string installed,CancellationToken cancellation) {
        Dictionary<string,object> release;
        using(var req=Request(Api+"/releases/latest",token,"application/vnd.github+json"))
        using(var res=await Http.SendAsync(req,cancellation)) {
            if(res.StatusCode==HttpStatusCode.Unauthorized)throw new LoginExpiredException();
            if(res.StatusCode==HttpStatusCode.NotFound || res.StatusCode==HttpStatusCode.Forbidden)throw new ApplicationException("access");
            res.EnsureSuccessStatusCode();
            release=Json.Deserialize<Dictionary<string,object>>(await res.Content.ReadAsStringAsync());
        }
        string tag=(string)release["tag_name"];
        if(!Regex.IsMatch(tag,@"^v\d+\.\d+\.\d+$"))throw new InvalidDataException("Invalid version");
        Version local;
        if(Version.TryParse(installed,out local) && new Version(tag.Substring(1))<=local)return null;
        var assets=((System.Collections.IEnumerable)release["assets"]).Cast<Dictionary<string,object>>();
        var asset=assets.Single(a=>(string)a["name"]=="Framequiz-Windows.zip");
        string digest=asset["digest"] as string;
        long size=Convert.ToInt64(asset["size"]);
        if(digest==null || !Regex.IsMatch(digest,"^sha256:[0-9a-f]{64}$") || size<=0 || size>256L*1024*1024)throw new InvalidDataException("Invalid release manifest");
        string zip=Path.Combine(stage,"release.zip");
        string url=Api+"/releases/assets/"+Convert.ToInt64(asset["id"]);
        for(int hop=0;hop<4;hop++) {
            using(var req=Request(url,hop==0?token:null,"application/octet-stream"))
            using(var res=await Http.SendAsync(req,HttpCompletionOption.ResponseHeadersRead,cancellation)) {
                if((int)res.StatusCode>=300 && (int)res.StatusCode<400) {
                    var next=res.Headers.Location;
                    if(next==null || !next.IsAbsoluteUri || next.Scheme!="https" || !next.IsDefaultPort ||
                      !(next.Host=="release-assets.githubusercontent.com" || next.Host=="objects.githubusercontent.com"))
                        throw new InvalidDataException("Invalid asset redirect");
                    url=next.AbsoluteUri;continue;
                }
                res.EnsureSuccessStatusCode();
                using(cancellation.Register(res.Dispose))
                using(var stream=await res.Content.ReadAsStreamAsync())using(var file=File.Create(zip)) {
                    var buf=new byte[65536];int n;long total=0;
                    try {
                        while((n=await stream.ReadAsync(buf,0,buf.Length,cancellation))!=0) {
                            total+=n;if(total>size)throw new InvalidDataException("Unexpected download size");
                            await file.WriteAsync(buf,0,n,cancellation);
                        }
                    } catch(IOException) {
                        cancellation.ThrowIfCancellationRequested();
                        throw;
                    } catch(ObjectDisposedException) {
                        cancellation.ThrowIfCancellationRequested();
                        throw;
                    }
                    cancellation.ThrowIfCancellationRequested();
                    if(total!=size)throw new InvalidDataException("Incomplete download");
                }
                break;
            }
        }
        cancellation.ThrowIfCancellationRequested();
        if("sha256:"+Hash(zip)!=digest)throw new InvalidDataException("SHA-256 mismatch");
        Extract(zip,Path.Combine(stage,"new"));
        return tag;
    }
    static readonly string[] Files={"Framequiz.exe","ffmpeg.exe","README.md","README.ru.md","FFmpeg-COPYING.txt","Update-Framequiz.ps1","window/FramequizWindow.exe","window/Microsoft.Web.WebView2.Core.dll","window/Microsoft.Web.WebView2.WinForms.dll","window/WebView2Loader.dll","window/WebView2-LICENSE.txt"};
    static void Extract(string zip,string target) {
        using(var archive=ZipFile.OpenRead(zip)) {
            if(!Files.OrderBy(x=>x,StringComparer.Ordinal).SequenceEqual(archive.Entries.Select(e=>e.FullName).OrderBy(x=>x,StringComparer.Ordinal)) ||
               archive.Entries.Sum(e=>e.Length)>512L*1024*1024)throw new InvalidDataException("Unexpected archive contents");
            Directory.CreateDirectory(Path.Combine(target,"window"));
            foreach(var entry in archive.Entries)entry.ExtractToFile(Path.Combine(target,entry.FullName));
        }
    }
    public static bool IsStudio(string root) {
        return File.Exists(Path.Combine(root,"Framequiz.exe")) && File.Exists(Path.Combine(root,"window","FramequizWindow.exe"));
    }
    public static void Apply(string root,string stage) {
        if(!IsStudio(root))throw new DirectoryNotFoundException("Framequiz installation");
        string backup=Path.Combine(stage,"previous");
        Directory.CreateDirectory(Path.Combine(backup,"window"));
        var changed=new List<string>();
        try {
            foreach(var name in Files) {
                var dest=Path.Combine(root,name);var fresh=Path.Combine(stage,"new",name);
                if(File.Exists(dest))File.Replace(fresh,dest,Path.Combine(backup,name));
                else File.Move(fresh,dest);
                changed.Add(name);
            }
        }catch{
            changed.Reverse();
            foreach(string name in changed) {
                string old=Path.Combine(backup,name),dest=Path.Combine(root,name);
                if(File.Exists(old))File.Replace(old,dest,null);else File.Delete(dest);
            }
            throw;
        }
    }
}

