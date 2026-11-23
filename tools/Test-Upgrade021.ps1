param([Parameter(Mandatory)][string]$PreviousZip,[Parameter(Mandatory)][string]$NewZip,[Parameter(Mandatory)][string]$Updater)
$ErrorActionPreference='Stop'
$test = Join-Path ([IO.Path]::GetTempPath()) ('framequiz-021-'+[guid]::NewGuid())
$installed = Join-Path $test 'installed'
$stage = Join-Path $installed '.framequiz-test'
$reference = Join-Path $test 'reference'
if((Get-FileHash $PreviousZip).Hash -ne '370DC17E5F558C26F95477F565624DE94E4A508989C47CCDE221915AD141F849'){throw 'Wrong starting archive'}
Expand-Archive $PreviousZip $installed
Expand-Archive $NewZip $reference
$null=New-Item -ItemType Directory -Path $stage
foreach($dir in 'tracks','exports'){
    $null=New-Item -ItemType Directory -Path (Join-Path $installed $dir)
    Set-Content (Join-Path $installed "$dir/preserve.txt") 'keep'
}
$null=[Reflection.Assembly]::LoadFrom((Resolve-Path $Updater))
$env:Path="$env:SystemRoot\System32;$env:SystemRoot"
if(Get-Command gh -ErrorAction SilentlyContinue){throw 'This check requires no gh.exe'}
$fields=New-Object 'System.Collections.Generic.Dictionary[string,string]'
$fields.Add('client_id',[ReleaseClient]::ClientId)
$challenge=[ReleaseClient]::OAuth('device/code',$fields).GetAwaiter().GetResult()
if(!$challenge.ContainsKey('device_code') -or !$challenge.ContainsKey('user_code')){throw 'GitHub device flow is unavailable'}
# CI has its own repository credential. Human device authorization is interactive.
$tag=[ReleaseClient]::Download($env:GH_TOKEN,$stage,'0.2.1').GetAwaiter().GetResult()
if($tag -ne 'v0.2.2'){throw "Unexpected release $tag"}
[ReleaseClient]::Apply($installed,$stage)
Get-ChildItem $reference -Recurse -File | ForEach-Object {
    $name=$_.FullName.Substring($reference.Length+1)
    if((Get-FileHash $_.FullName).Hash -ne (Get-FileHash (Join-Path $installed $name)).Hash){throw "Mismatch: $name"}
}
foreach($dir in 'tracks','exports'){if((Get-Content (Join-Path $installed "$dir/preserve.txt")) -ne 'keep'){throw 'Lost local data'}}
$env:FRAMEQUIZ_PORT='39794'
$log=Join-Path $test 'session.txt'
$process=Start-Process (Join-Path $installed Framequiz.exe) -ArgumentList '--headless' -WindowStyle Hidden -PassThru -RedirectStandardOutput $log
try{
    for($i=0;$i -lt 50;$i++){Start-Sleep -Milliseconds 200; $url=Get-Content $log -ErrorAction SilentlyContinue;if($url){break}}
    $uri=[uri]$url
    $html=Invoke-WebRequest -UseBasicParsing ($uri.GetLeftPart('Authority')+'/en')
    if(!$html.Content.Contains('v0.2.2') -or !$html.Content.Contains('id="openUpdater"')){throw 'Wrong client UI'}
    Write-Output 'Published 0.2.1 upgraded to 0.2.2 without GitHub CLI. Device challenge, release digest, installed files, user data and startup verified.'
} finally { if(!$process.HasExited){$process.Kill()} }
