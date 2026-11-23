using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class StudioWindow : Form
{
    private static bool Russian { get { return System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ru"; } }
    private readonly Uri studio;

    private readonly NotifyIcon tray;
    private readonly WebView2 browser;
    private bool exiting;

    private StudioWindow(Uri studio, EventWaitHandle activation, int backend)
    {
        this.studio = studio;
        Text = "Framequiz Studio";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(1360, 900);
        MinimumSize = new Size(600, 480);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(25, 23, 25);
        browser = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
        Controls.Add(browser);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Открыть Framequiz Studio", null, (s, e) => Restore());
        menu.Items.Add("Свернуть в трей", null, (s, e) => Hide());
        menu.Items.Add("Открыть в браузере", null, (s, e) => OpenLink(studio));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Выход", null, (s, e) => ExitStudio());
        tray = new NotifyIcon { Text = Text, Icon = Icon, ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Restore(); };
        var process = Process.GetProcessById(backend);
        var updateExit = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Framequiz.Update." + backend);
        var updateWait = ThreadPool.RegisterWaitForSingleObject(updateExit, (s,t) => Dispatch(ExitStudio),null,Timeout.Infinite,false);
        process.EnableRaisingEvents = true;
        process.Exited += (s, e) => Dispatch(ExitStudio);
        var registration = ThreadPool.RegisterWaitForSingleObject(
            activation, (s, expired) => Dispatch(Restore), null, Timeout.Infinite, false);
        FormClosed += (s, e) => {
            updateWait.Unregister(null); updateExit.Dispose();
            registration.Unregister(null);
            process.Dispose();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
        };
    }

    protected override void WndProc(ref Message message)
    {
        const int CloseMessage = 0x0010;
        if (message.Msg == CloseMessage && !exiting)
        {
            Hide();
            return;
        }
        base.WndProc(ref message);
    }

    private void Dispatch(Action action)
    {
        try { BeginInvoke(action); }
        catch (InvalidOperationException) { }
    }

    private async void InitializeBrowser()
    {
        try
        {
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Framequiz Studio", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await browser.EnsureCoreWebView2Async(environment);
            browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            browser.CoreWebView2.NavigationStarting += (s, e) => {
                Uri target;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target)) { e.Cancel = true; return; }
                if (studio.IsBaseOf(target)) return;
                e.Cancel = true;
                OpenLink(target);
            };
            browser.CoreWebView2.NewWindowRequested += (s, e) => {
                e.Handled = true;
                Uri target;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out target)) OpenLink(target);
            };
            browser.CoreWebView2.WebMessageReceived += (s, e) => {
                if (studio.IsBaseOf(new Uri(e.Source)) && e.TryGetWebMessageAsString() == "hide")
                    Hide();
            };
            browser.CoreWebView2.NavigationCompleted += (s, e) => {
                bool english = browser.Source.AbsolutePath == "/en";
                var items = tray.ContextMenuStrip.Items;
                items[0].Text = english ? "Open Framequiz Studio" : "Открыть Framequiz Studio";
                items[1].Text = english ? "Minimize to tray" : "Свернуть в трей";
                items[2].Text = english ? "Open in browser" : "Открыть в браузере";
                items[4].Text = english ? "Exit" : "Выход";
            };
            browser.Source = studio;
        }
        catch (Exception e)
        {
            if (!exiting) MessageBox.Show((Russian ? "Не удалось открыть встроенное окно. Проверьте, установлен ли Microsoft Edge WebView2 Runtime. Студию можно открыть в браузере через меню трея." : "Could not open the desktop window. Check that Microsoft Edge WebView2 Runtime is installed, or open the studio in your browser from the tray menu.") + "\n\n" + e.Message,
                Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static void OpenLink(Uri url)
    {
        if (url.Scheme != "http" && url.Scheme != "https") return;
        try { Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception e) { MessageBox.Show(e.Message, "Framequiz Studio"); }
    }

    private void Restore()
    {
        if (exiting) return;
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitStudio()
    {
        exiting = true;
        Close();
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 4 && args[0] == "--update") {
            var root = Directory.GetParent(Path.GetDirectoryName(Application.ExecutablePath)).FullName;
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Framequiz Studio","Updater",new Version(args[1]).ToString());
            Directory.CreateDirectory(dir);
            var exe = Path.Combine(dir,"Framequiz-Update.exe");
            string pending=Path.Combine(dir,Guid.NewGuid().ToString("N")+".tmp");
            try {
                using(var input=typeof(StudioWindow).Assembly.GetManifestResourceStream("Framequiz.Update"))
                using(var output=File.Create(pending)) input.CopyTo(output);
                if(!File.Exists(exe)) File.Move(pending,exe);
                else {
                    using(var sha=System.Security.Cryptography.SHA256.Create())
                    using(var expected=File.OpenRead(pending))
                    using(var actual=File.OpenRead(exe))
                        if(!string.Equals(Convert.ToBase64String(sha.ComputeHash(expected)),Convert.ToBase64String(sha.ComputeHash(actual)))) throw new IOException("Updater integrity check failed.");
                }
            } finally {if(File.Exists(pending))File.Delete(pending);}
            var start = new ProcessStartInfo(exe, "\"" + root + "\" " + args[1] + " " + args[2] + " " + args[3]);
            start.UseShellExecute=false;
            Process.Start(start);
            return;
        }
        if (args.Length != 3) return;
        var studio = new Uri(args[0]);
        var name = @"Local\FramequizStudio.Open." + studio.Port;
        bool created;
        using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, name, out created))
        {
            if (!created) { activation.Set(); return; }
            if (args[1] == "activate")
            {
                MessageBox.Show(Russian ? "Локальный порт занят. Если открыта предыдущая версия Framequiz, завершите её кнопкой питания и запустите обновление снова." : "The local port is in use. Exit the previous instance from the tray and reopen the studio.", "Framequiz Studio");
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new StudioWindow(studio, activation, int.Parse(args[1])))
            {
                window.Shown += (s, e) => {
                    if (args[2] == "tray") window.Hide();
                    window.InitializeBrowser();
                };
                Application.Run(window);
            }
        }
    }
}
