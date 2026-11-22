param([Parameter(Mandatory)][int]$StudioPid, [Parameter(Mandatory)][version]$CurrentVersion)
$ErrorActionPreference = 'Stop'
$repo = 'Rub1nchik702/framequiz'
$root = $PSScriptRoot
$log = Join-Path $root 'update-status.txt'
$stage = Join-Path $root ('.framequiz-update-' + [guid]::NewGuid())
$allowed = @('Framequiz.exe','ffmpeg.exe','README.md','README.ru.md','FFmpeg-COPYING.txt','Update-Framequiz.ps1','window/FramequizWindow.exe','window/Microsoft.Web.WebView2.Core.dll','window/Microsoft.Web.WebView2.WinForms.dll','window/WebView2Loader.dll','window/WebView2-LICENSE.txt')
try {
    'checking' | Set-Content -Encoding UTF8 $log
    $gh = (Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue).Source
    if (!$gh) { 'cli' | Set-Content -Encoding UTF8 $log; return }
    $lock = [IO.File]::Open((Join-Path $root '.framequiz-update.lock'),'OpenOrCreate','ReadWrite','None')
    $raw = & $gh api "repos/$repo/releases/latest" 2>$null
    if ($LASTEXITCODE -ne 0) { 'auth' | Set-Content -Encoding UTF8 $log; return }
    $release = $raw | ConvertFrom-Json
    if ($release.tag_name -notmatch '^v([0-9]+\.[0-9]+\.[0-9]+)$') { throw 'Unsupported release tag.' }
    if ([version]$Matches[1] -le $CurrentVersion) { "current $CurrentVersion" | Set-Content -Encoding UTF8 $log; return }
    $asset = @($release.assets | Where-Object name -eq 'Framequiz-Windows.zip')
    if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'Release asset or SHA-256 missing.' }
    $digest = $Matches[1]
    $null = New-Item -ItemType Directory -Path $stage
    "downloading $($release.tag_name)" | Set-Content -Encoding UTF8 $log
    & $gh release download $release.tag_name --repo $repo --pattern 'Framequiz-Windows.zip' --dir $stage
    if ($LASTEXITCODE -ne 0) { throw 'Release download failed.' }
    $zip = Join-Path $stage 'Framequiz-Windows.zip'
    if ((Get-FileHash $zip).Hash -ne $digest) { throw 'Release digest mismatch.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $names = @($archive.Entries | ForEach-Object FullName)
        if ($names.Count -ne $allowed.Count -or (Compare-Object $allowed $names -CaseSensitive)) { throw 'Unexpected release contents.' }
        $fresh = Join-Path $stage 'new'
        [IO.Compression.ZipFile]::ExtractToDirectory($zip,$fresh)
    } finally { $archive.Dispose() }
    "ready $($release.tag_name)" | Set-Content -Encoding UTF8 $log
    Get-Process -Id $StudioPid -ErrorAction SilentlyContinue | Wait-Process
    $backup = Join-Path $stage 'previous'
    $replaced = @()
    foreach ($name in $allowed) {
        $old = Join-Path $root $name
        if (Test-Path -LiteralPath $old) {
            $copy = Join-Path $backup $name
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($copy)) | Out-Null
            [IO.File]::Copy($old,$copy)
        }
    }
    try {
        foreach ($name in $allowed) {
            $dst = Join-Path $root $name
            $src = Join-Path $fresh $name
            if ([IO.File]::Exists($dst)) { [IO.File]::Replace($src,$dst,($src + '.old')) }
            else { [IO.File]::Move($src,$dst) }
            $replaced += $name
        }
    } catch {
        foreach ($name in $replaced) {
            $saved = Join-Path $backup $name
            if ([IO.File]::Exists($saved)) { [IO.File]::Copy($saved,(Join-Path $root $name),$true) }
            else { [IO.File]::Delete((Join-Path $root $name)) }
        }
        throw
    }
    "installed $($release.tag_name)" | Set-Content -Encoding UTF8 $log
} catch {
    "failed $($_.Exception.Message)" | Set-Content -Encoding UTF8 $log
} finally {
    if ($lock) { $lock.Dispose() }
    if ([IO.Directory]::Exists($stage) -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -eq $root) { [IO.Directory]::Delete($stage,$true) }
}
