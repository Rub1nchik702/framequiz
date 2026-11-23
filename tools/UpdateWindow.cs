using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class UpdateWindow : Form {
    readonly string root, version;
    readonly int parent;
    readonly bool en;
    readonly Button action=new Button(), logout=new Button();
    readonly Label status=new Label();
    readonly TextBox code=new TextBox();
    readonly CancellationTokenSource cancel=new CancellationTokenSource();
    static readonly string Vault=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Framequiz Studio","github.user");
    string L(string russian,string english){return en?english:russian;}
    void Report(string state,string message){
        if(IsDisposed)return;
        status.Text=message;
        File.WriteAllText(Path.Combine(root,"update-status.txt"),state,new UTF8Encoding(false));
    }
    UpdateWindow(string folder,string installed,int pid,bool english) {
        root=folder;version=installed;parent=pid;en=english;
        Text="Framequiz Studio · GitHub";ClientSize=new Size(520,220);StartPosition=FormStartPosition.CenterScreen;
        Font=new Font("Segoe UI",10);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;
        status.SetBounds(20,18,480,86);
        status.Text=L("Войдите в GitHub с аккаунтом, которому доступен Framequiz.","Sign in with a GitHub account that has access to Framequiz.");
        code.SetBounds(20,108,190,30);code.ReadOnly=true;code.Visible=false;
        action.SetBounds(20,163,210,38);logout.SetBounds(247,163,245,38);
        logout.Text=L("Выйти из аккаунта","Sign out");
        logout.Click+=(s,e)=>{File.Delete(Vault);Buttons();status.Text=L("Вы вышли из GitHub.","Signed out of GitHub.");};
        action.Click+=async(s,e)=>await Run();
        Controls.AddRange(new Control[]{status,code,action,logout});
        FormClosing+=(s,e)=>cancel.Cancel();
        Buttons();
    }
    void Buttons(){logout.Visible=File.Exists(Vault);action.Text=logout.Visible?L("Обновить","Update"):L("Войти через GitHub","Sign in with GitHub");}
    async Task<string> SignIn(){
        var reply=await ReleaseClient.OAuth("device/code",new Dictionary<string,string>{{"client_id",ReleaseClient.ClientId}});
        if(!reply.ContainsKey("device_code"))throw new ApplicationException("Device authorization unavailable");
        string user=(string)reply["user_code"];
        code.Text=user;code.Visible=true;code.SelectAll();
        status.Text=L("Подтвердите код на странице GitHub, затем вернитесь сюда. Код можно скопировать из поля ниже.","Confirm the code on GitHub, then return here. You can copy it from the field below.");
        Process.Start(new ProcessStartInfo("https://github.com/login/device"){UseShellExecute=true});
        var until=DateTime.UtcNow.AddSeconds(Convert.ToInt32(reply["expires_in"]));
        int seconds=Math.Max(5,Convert.ToInt32(reply["interval"]));
        while(DateTime.UtcNow<until) {
            await Task.Delay(TimeSpan.FromSeconds(seconds),cancel.Token);
            var data=await ReleaseClient.OAuth("oauth/access_token",new Dictionary<string,string>{{"client_id",ReleaseClient.ClientId},{"device_code",(string)reply["device_code"]},{"grant_type","urn:ietf:params:oauth:grant-type:device_code"}});
            if(data.ContainsKey("access_token")){
                string token=(string)data["access_token"];
                Directory.CreateDirectory(Path.GetDirectoryName(Vault));
                File.WriteAllBytes(Vault,ProtectedData.Protect(Encoding.UTF8.GetBytes(token),null,DataProtectionScope.CurrentUser));
                return token;
            }
            string error=Convert.ToString(data["error"]);
            if(error=="slow_down")seconds+=5;else if(error!="authorization_pending")break;
        }
        throw new ApplicationException(L("Вход не подтверждён. Повторите попытку.","Sign-in was not confirmed. Try again."));
    }
    bool Running(){
        foreach(var p in Process.GetProcessesByName("Framequiz"))using(p){
            try{if(string.Equals(p.MainModule.FileName,Path.Combine(root,"Framequiz.exe"),StringComparison.OrdinalIgnoreCase))return true;}
            catch(System.ComponentModel.Win32Exception){}catch(InvalidOperationException){}
        }
        return false;
    }
    async Task Run(){
        action.Enabled=logout.Enabled=false;
        string stage=Path.Combine(root,".framequiz-update-"+Guid.NewGuid().ToString("N"));
        bool applying=false;
        try{
            if(!File.Exists(Vault)){
                await SignIn();
                Report("signedin",L("Вход выполнен. Нажмите «Обновить».","Signed in. Click Update."));
                return;
            }
            var token=Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(Vault),null,DataProtectionScope.CurrentUser));
            Directory.CreateDirectory(stage);
            Report("downloading",L("Проверяем версию и скачиваем обновление…","Checking the release and downloading the update…"));
            string tag=await ReleaseClient.Download(token,stage,version);
            cancel.Token.ThrowIfCancellationRequested();
            if(tag==null || ReleaseClient.Hash(Path.Combine(root,"Framequiz.exe"))==ReleaseClient.Hash(Path.Combine(stage,"new","Framequiz.exe"))){
                Report("current",L("Установлена последняя версия.","You are up to date."));return;
            }
            Report("ready "+tag,L("Обновление проверено. Если Framequiz открыт, завершите его через меню трея.","Update verified. If Framequiz is open, exit it from the tray."));
            if(parent>0)try{using(var signal=EventWaitHandle.OpenExisting(@"Local\Framequiz.Update."+parent))signal.Set();}catch(WaitHandleCannotBeOpenedException){}
            while(Running())await Task.Delay(500,cancel.Token);
            using(var fileLock=new FileStream(Path.Combine(root,".framequiz-update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
                applying=true;
                ReleaseClient.Apply(root,stage);
                applying=false;
            }
            Report("installed "+tag,L("Обновление установлено.","Update installed."));
            Process.Start(Path.Combine(root,"Framequiz.exe"));Close();
        }catch(UnauthorizedAccessException e){
            // A 401 from GitHub has no file path. Local permission errors retain the saved login.
            if(e.GetType()==typeof(LoginExpiredException)){File.Delete(Vault);Report("auth",L("Сеанс истёк. Войдите снова.","Session expired. Sign in again."));}
            else Report("failed",e.Message);
        }catch(CryptographicException){File.Delete(Vault);Report("auth",L("Войдите в GitHub снова.","Please sign in again."));}
        catch(OperationCanceledException){if(!IsDisposed)status.Text=L("Операция отменена.","Operation canceled.");}
        catch(Exception e){Report("failed",e.Message=="access"?L("У аккаунта нет доступа к релизу. Примите приглашение в репозиторий или смените аккаунт.","Release access denied. Accept your repository invitation or switch accounts."):e.Message);}
        finally{
            if(!applying && Directory.Exists(stage))try{Directory.Delete(stage,true);}catch(IOException){}
            if(!IsDisposed){action.Enabled=logout.Enabled=true;code.Visible=false;Buttons();}
        }
    }
    [STAThread] static void Main(string[] args){
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        bool en=args.Length==4?args[3]=="en":System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName!="ru";
        string root=args.Length==4?args[0]:Path.GetDirectoryName(Application.ExecutablePath);
        if(!ReleaseClient.IsStudio(root)){
            using(var pick=new OpenFileDialog{Title=en?"Select your installed Framequiz.exe":"Выберите установленный Framequiz.exe",Filter="Framequiz|Framequiz.exe"}){
                if(pick.ShowDialog()!=DialogResult.OK)return;root=Path.GetDirectoryName(pick.FileName);
            }
        }
        if(!ReleaseClient.IsStudio(root)){MessageBox.Show(en?"Studio installation not found.":"Установка Framequiz не найдена.");return;}
        bool created;
        using(var mutex=new Mutex(true,@"Local\Framequiz.GitHubUpdate",out created)){
            if(!created){MessageBox.Show(en?"The updater is already open.":"Окно обновления уже открыто.");return;}
            int pid=0;if(args.Length==4)int.TryParse(args[2],out pid);
            Application.Run(new UpdateWindow(root,args.Length==4?args[1]:null,pid,en));
        }
    }
}
public sealed class LoginExpiredException : UnauthorizedAccessException { }
