param(
    [Parameter(Mandatory)][string]$PreviousZip,
    [Parameter(Mandatory)][string]$NewZip
)
$ErrorActionPreference = 'Stop'
if (!$env:CI -or !$env:GH_TOKEN) { throw 'Run on a disposable CI runner with repository access.' }

$test = Join-Path ([IO.Path]::GetTempPath()) ('framequiz-upgrade-' + [guid]::NewGuid())
$installed = Join-Path $test 'installed'
$reference = Join-Path $test 'reference'
Expand-Archive $PreviousZip $installed
Expand-Archive $NewZip $reference
$track = Join-Path $installed 'tracks/123456'
$exports = Join-Path $installed 'exports'
New-Item -ItemType Directory -Path $track,$exports | Out-Null
Set-Content -Encoding ASCII (Join-Path $track 'track.json') '{"id":"123456","anime":"Fixture anime","title":"Fixture opening","kind":"OP","level":"easy","durationMs":4000,"offset":1}'
Set-Content -Encoding ASCII (Join-Path $exports 'preserve.txt') 'Existing export'
& (Join-Path $installed 'ffmpeg.exe') -v error -f lavfi -i 'sine=frequency=440:duration=4' -ac 2 (Join-Path $track 'track.flac')
if ($LASTEXITCODE) { throw 'Could not generate the library fixture.' }
$metadataHash = (Get-FileHash (Join-Path $track 'track.json')).Hash
$audioHash = (Get-FileHash (Join-Path $track 'track.flac')).Hash

# Seed only the CI runner's vault. A person normally authorizes GitHub in their browser.
Add-Type -AssemblyName System.Security
$vault = Join-Path $env:LOCALAPPDATA 'Framequiz Studio/github.user'
if (Test-Path $vault) { throw 'This isolated test requires a fresh GitHub vault.' }
New-Item -Force -ItemType Directory -Path (Split-Path $vault) | Out-Null
$encrypted = [Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($env:GH_TOKEN), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[IO.File]::WriteAllBytes($vault, $encrypted)
Remove-Item Env:GH_TOKEN

$env:FRAMEQUIZ_PORT = '39793'
$exe = Join-Path $installed Framequiz.exe
$old = Start-Process $exe -ArgumentList '--tray' -PassThru
$edgeProcess = $null
try {
    # Use the supported browser interface against the already running desktop backend.
    $deadline = (Get-Date).AddSeconds(25)
    $sessionUrl = $null
    do {
        foreach ($window in Get-CimInstance Win32_Process -Filter "ParentProcessId=$($old.Id)") {
            if ($window.CommandLine -match 'http://127\.0\.0\.1:39793/#([a-f0-9]{64})') {
                $sessionUrl = $Matches[0].Replace("/#", "/en#")
                break
            }
        }
        if (!$sessionUrl) { Start-Sleep -Milliseconds 500 }
    } until ($sessionUrl -or $old.HasExited -or (Get-Date) -gt $deadline)
    if (!$sessionUrl) { throw 'Desktop backend did not launch its window.' }
    $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'
    if (!(Test-Path $edge)) { throw 'Microsoft Edge is missing on the test runner.' }
    $profile = Join-Path $test 'edge'
    $edgeProcess = Start-Process $edge -ArgumentList @(
        '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=19222',
        ('--user-data-dir="' + $profile + '"'), $sessionUrl
    ) -PassThru
    $driver = Join-Path $test 'click-update.cjs'
    @"
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let tabs;
  for (let i = 0; i < 90; i++) {
    try {
      tabs = await (await fetch('http://127.0.0.1:19222/json/list')).json();
      if (tabs.some(tab => tab.url.startsWith('http://127.0.0.1:39793/'))) break;
    } catch {}
    await sleep(500);
  }
  const tab = tabs?.find(candidate => candidate.url.startsWith('http://127.0.0.1:39793/'));
  assert(tab, 'Edge did not open the 0.2.4 editor');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    async function evaluate(expression) {
      const command = ++id;
      return new Promise(resolve => {
        function receive(event) {
          const response = JSON.parse(event.data);
          if (response.id !== command) return;
          ws.removeEventListener('message', receive);
          resolve(response.result?.result?.value);
        }
        ws.addEventListener('message', receive);
        ws.send(JSON.stringify({ id: command, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    }
    for (let i = 0; i < 45; i++) {
      if (await evaluate('typeof api === "function" && document.querySelector("#updateBadge")?.textContent === "v0.2.4"')) break;
      await sleep(500);
    }
    assert(await evaluate('document.querySelector("#updateBadge").textContent === "v0.2.4" && typeof api === "function"'));
    await evaluate('document.querySelector("#updateBadge").click(); document.querySelector("#openUpdater").click(); true');
  } finally { ws.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
"@ | Set-Content -Encoding ASCII $driver
    node $driver
    if ($LASTEXITCODE) { throw 'Could not click Update in Framequiz 0.2.4.' }

    # The hosted runner does not expose the GUI through Windows UI Automation.
    # Drive the exact released WinForms button through its normal Click event.
    $deadline = (Get-Date).AddSeconds(20)
    $publishedHelper = Join-Path $env:LOCALAPPDATA 'Framequiz Studio/Updater/0.2.4/Framequiz-Update.exe'
    do {
        $openedHelper = Get-Process -Name 'Framequiz-Update' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $publishedHelper } | Select-Object -First 1
        if (!$openedHelper) { Start-Sleep -Milliseconds 250 }
    } until ($openedHelper -or (Get-Date) -gt $deadline)
    if (!$openedHelper) { throw 'The in-app button did not launch its released updater.' }
    $openedHelper.Kill()
    if (!$openedHelper.WaitForExit(10000)) { throw 'Could not close the test updater instance.' }

    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @"
using System;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
public static class ReleasedUpdateButton {
    public static void Click(string path, string installation, int parent) {
        Exception failure = null;
        var ui = new Thread(() => {
            try {
                var type = Assembly.LoadFrom(path).GetType("UpdateWindow", true);
                var constructor = type.GetConstructor(BindingFlags.NonPublic | BindingFlags.Instance,
                    null, new[] { typeof(string), typeof(string), typeof(int), typeof(bool) }, null);
                using (var form = (Form)constructor.Invoke(new object[] { installation, "0.2.4", parent, true }))
                using (var watchdog = new System.Windows.Forms.Timer { Interval = 240000 }) {
                    var button = (Button)type.GetField("action", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form);
                    if (button.Text != "Update") throw new InvalidOperationException("No authenticated Update button.");
                    form.Shown += (sender, args) => form.BeginInvoke(new Action(button.PerformClick));
                    watchdog.Tick += (sender, args) => { watchdog.Stop(); form.Close(); };
                    var status = (Label)type.GetField("status", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form);
                    using (var monitor = new System.Windows.Forms.Timer { Interval = 500 }) {
                        monitor.Tick += (sender, args) => {
                            if (!button.Enabled || !System.IO.File.Exists(System.IO.Path.Combine(installation, "update-status.txt"))) return;
                            if (System.IO.File.ReadAllText(System.IO.Path.Combine(installation, "update-status.txt")).StartsWith("failed")) {
                                failure = new InvalidOperationException(status.Text);
                                form.Close();
                            }
                        };
                        monitor.Start();
                        watchdog.Start();
                        Application.Run(form);
                    }
                }
            } catch (Exception error) { failure = error; }
        });
        ui.SetApartmentState(ApartmentState.STA);
        ui.IsBackground = true;
        ui.Start();
        if (!ui.Join(TimeSpan.FromMinutes(5))) throw new TimeoutException("The released updater did not return.");
        if (failure != null) throw failure;
    }
}
"@
    [ReleasedUpdateButton]::Click($publishedHelper, $installed, $old.Id)

    $deadline = (Get-Date).AddMinutes(4)
    $statusPath = Join-Path $installed 'update-status.txt'
    do {
        Start-Sleep -Seconds 1
        $status = Get-Content $statusPath -ErrorAction SilentlyContinue
        if ($status -match '^(failed|auth|canceled)') { throw "Updater stopped: $status" }
    } until ($status -eq 'installed v2.5.0' -or (Get-Date) -gt $deadline)
    if ($status -ne 'installed v2.5.0' -or !$old.HasExited) { throw "Installation did not finish: $status" }

    Get-ChildItem $reference -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($reference.Length + 1)
        if ((Get-FileHash $_.FullName).Hash -ne (Get-FileHash (Join-Path $installed $relative)).Hash) {
            throw "Installed file differs from 2.5.0: $relative"
        }
    }
    if ((Get-FileHash (Join-Path $track 'track.json')).Hash -ne $metadataHash -or
        (Get-FileHash (Join-Path $track 'track.flac')).Hash -ne $audioHash -or
        (Get-Content (Join-Path $exports 'preserve.txt')) -ne 'Existing export') {
        throw 'The library or exports changed.'
    }

    $env:FRAMEQUIZ_PORT = '39794'
    $log = Join-Path $test 'session.txt'
    $probe = Start-Process $exe -ArgumentList '--headless' -WindowStyle Hidden -PassThru -RedirectStandardOutput $log
    try {
        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $url = Get-Content $log -ErrorAction SilentlyContinue
        } until ($url -or (Get-Date) -gt $deadline)
        if (!$url) { throw 'Updated client failed to start.' }
        $uri = [uri]$url
        $origin = $uri.GetLeftPart('Authority')
        $key = $uri.Fragment.Substring(1)
        $html = Invoke-WebRequest -UseBasicParsing "$origin/en"
        if (!$html.Content.Contains('v2.5.0')) { throw 'Incorrect client version.' }
        $library = Invoke-RestMethod -Method Post -Uri "$origin/api/tracks" -Headers @{'X-Quiz-Studio'=$key} -Body '{}'
        $entry = $library.data | Where-Object id -eq '123456'
        if ($entry.title -ne 'Fixture opening' -or $entry.offset -ne 1) { throw 'Updated client cannot read the existing track.' }
        $preview = Invoke-WebRequest -UseBasicParsing "$origin/clip/123456/1/2?session=$key"
        if ($preview.Content.Length -lt 1000) { throw 'Updated client cannot play the existing track.' }
    } finally { if (!$probe.HasExited) { $probe.Kill() } }

    Write-Output 'Clicked Update in 0.2.4 and in its graphical updater. Installed the published 2.5.0 package. Existing FLAC and metadata hashes match, the track is playable, and exports remain present.'
} finally {
    if ($edgeProcess -and !$edgeProcess.HasExited) { $edgeProcess.Kill() }
    if (!$old.HasExited) { $old.Kill() }
}

