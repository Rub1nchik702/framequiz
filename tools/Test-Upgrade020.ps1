param([Parameter(Mandatory)][string]$PreviousZip,[Parameter(Mandatory)][string]$NewZip)
$ErrorActionPreference = 'Stop'
$oldHash = '0EF94A1BB2C9C402D75069F61AEAE36A4E8BF02F3B5987A0FC3D0E1D6EA0C28A'
if ((Get-FileHash $PreviousZip).Hash -ne $oldHash) { throw 'Expected the published 0.2.0 archive.' }
$test = Join-Path ([IO.Path]::GetTempPath()) ('framequiz-upgrade-' + [guid]::NewGuid())
$installed = Join-Path $test 'installed'
$reference = Join-Path $test 'reference'
Expand-Archive $PreviousZip $installed
Expand-Archive $NewZip $reference
$installedExe = Join-Path $installed Framequiz.exe
foreach ($dir in @('tracks','exports')) {
    New-Item -ItemType Directory -Path (Join-Path $installed $dir) | Out-Null
    Set-Content -LiteralPath (Join-Path $installed "$dir/preserve.txt") -Value 'user data'
}
$env:FRAMEQUIZ_PORT = '39793'
$old = Start-Process -FilePath $installedExe -ArgumentList '--tray' -WindowStyle Hidden -PassThru
try {
    $deadline = (Get-Date).AddMinutes(4)
    do {
        Start-Sleep -Seconds 2
        $status = Get-Content -LiteralPath (Join-Path $installed update-status.txt) -ErrorAction SilentlyContinue
        if ($old.HasExited -or $status -like 'Update postponed*') { throw "0.2.0 update failed: $status" }
    } until ($status -like 'Downloaded v0.2.1.*' -or (Get-Date) -gt $deadline)
    if ($status -notlike 'Downloaded v0.2.1.*') { throw "Download timed out: $status" }
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:39793/api/quit" -Headers @{'X-Quiz-Studio'='1'} -Body '{}' | Out-Null
    if (!$old.WaitForExit(20000)) { throw 'Old client did not exit.' }
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Seconds 1
        $status = Get-Content -LiteralPath (Join-Path $installed update-status.txt)
    } until ($status -eq 'Installed v0.2.1.' -or (Get-Date) -gt $deadline)
    if ($status -ne 'Installed v0.2.1.') { throw "Installation failed: $status" }
    Get-ChildItem -LiteralPath $reference -Recurse -File | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($reference,$_.FullName)
        if ((Get-FileHash (Join-Path $installed $relative)).Hash -ne (Get-FileHash $_.FullName).Hash) { throw "Installed file differs: $relative" }
    }
    foreach ($dir in @('tracks','exports')) {
        if ((Get-Content (Join-Path $installed "$dir/preserve.txt")) -ne 'user data') { throw 'Local data changed.' }
    }
    $stdout = Join-Path $test 'session.txt'
    $new = Start-Process $installedExe -ArgumentList '--headless' -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout
    try {
        $deadline = (Get-Date).AddSeconds(15)
        do { Start-Sleep -Milliseconds 200; $link = Get-Content $stdout -ErrorAction SilentlyContinue } until ($link -or (Get-Date) -gt $deadline)
        if (!$link) { throw 'Updated client did not start.' }
        $uri = [uri]$link
        $homePage = Invoke-WebRequest "$($uri.GetLeftPart('Authority'))/en"
        if (!$homePage.Content.Contains('v0.2.1')) { throw 'Wrong UI version.' }
        $result = Invoke-RestMethod -Method Post -Uri "$($uri.GetLeftPart('Authority'))/api/tracks" -Headers @{'X-Quiz-Studio'=$uri.Fragment.Substring(1)} -Body '{}'
        if ($null -eq $result.data) { throw 'Updated library unavailable.' }
        Write-Output '0.2.0 downloaded and installed 0.2.1. Package hashes, user data and authenticated startup verified.'
    } finally { if (!$new.HasExited) { $new.Kill() } }
} finally { if (!$old.HasExited) { $old.Kill() } }
