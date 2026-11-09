param([switch]$Qa)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = '1.0.4314.35'
$cache = Join-Path $env:LOCALAPPDATA "Cinema\DesktopBuild\$version"
$sdk = Join-Path $cache 'sdk'
$lib = Join-Path $sdk 'lib\net462'
$install = Join-Path $root $(if ($Qa) { '.local\desktop-qa' } else { '.local\desktop' })
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path (Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll'))) {
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $archive = Join-Path $cache 'webview2.zip'
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $sdk -Force
}
New-Item -ItemType Directory -Path $install -Force | Out-Null
foreach ($assembly in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll') {
    Copy-Item -LiteralPath (Join-Path $lib $assembly) -Destination $install
}
Copy-Item -LiteralPath (Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $install
$exe = Join-Path $install 'Cinema.exe'
$sources = @(Join-Path $PSScriptRoot 'Cinema.cs')
if ($Qa) { $sources += '/define:CINEMA_QA', (Join-Path $PSScriptRoot 'Cinema.Qa.cs') }
& $compiler /nologo /target:winexe /platform:x64 "/out:$exe" "/win32icon:$root\cinema.ico" /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$lib\Microsoft.Web.WebView2.Core.dll" "/r:$lib\Microsoft.Web.WebView2.WinForms.dll" @sources
if ($LASTEXITCODE -ne 0) { throw 'Cinema desktop compilation failed.' }
Get-Item -LiteralPath $exe
