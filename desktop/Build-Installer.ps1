param(
    [string]$OutputDirectory,
    [string]$CompilerPath,
    [string]$SearchPluginDirectory,
    [switch]$Online
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$buildRoot = Join-Path $root '.local\installer'
$cache = Join-Path $env:LOCALAPPDATA 'Cinema\InstallerBuild'
if ($SearchPluginDirectory -and -not $OutputDirectory) {
    throw 'A curated search plugin build needs its own explicit -OutputDirectory.'
}
if (-not $OutputDirectory) { $OutputDirectory = $buildRoot }
$null = New-Item -ItemType Directory -Path $buildRoot, $cache, $OutputDirectory -Force
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
if ($SearchPluginDirectory -and $OutputDirectory -eq (Resolve-Path -LiteralPath $buildRoot).Path) {
    throw 'Choose a different -OutputDirectory for the curated search plugin installer.'
}
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$assets = [ordered]@{
    node = @{
        Name = 'node-v22.23.4-win-x64.zip'
        Urls = @('https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip')
        Sha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
        Source = 'https://nodejs.org/dist/v22.23.4/'
    }
    qbit = @{
        Name = 'qbittorrent_5.2.4_x64_setup.exe'
        Urls = @(
            'https://github.com/qbittorrent/qBittorrent/releases/download/release-5.2.4/qbittorrent_5.2.4_x64_setup.exe',
            'https://downloads.sourceforge.net/project/qbittorrent/qbittorrent-win32/qbittorrent-5.2.4/qbittorrent_5.2.4_x64_setup.exe',
            'https://cfhcable.dl.sourceforge.net/project/qbittorrent/qbittorrent-win32/qbittorrent-5.2.4/qbittorrent_5.2.4_x64_setup.exe'
        )
        Sha256 = 'ef6efe581d80efeb0a77df281d93f93021fbdcc48e4d8f7b341dc864f53c30dd'
        Source = 'https://sourceforge.net/projects/qbittorrent/files/qbittorrent/qbittorrent-5.2.4/'
    }
    qbitLicense = @{
        Name = 'qbittorrent-5.2.4-COPYING'
        Urls = @('https://raw.githubusercontent.com/qbittorrent/qBittorrent/release-5.2.4/COPYING')
        Sha256 = 'e675cd856f9817474455200ba7e6f5b7cc42d6598a5eecbbbdaa0e6fd304d6b7'
    }
    python = @{
        Name = 'python-3.13.17-embed-amd64.zip'
        Urls = @('https://www.python.org/ftp/python/3.13.17/python-3.13.17-embed-amd64.zip')
        Sha256 = '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38'
        Source = 'https://www.python.org/downloads/release/python-31317/'
    }
    ffmpeg = @{
        Name = 'b6.1.1-ffmpeg-win32-x64'
        Urls = @('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64')
        Sha256 = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00'
        Source = 'https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1'
    }
    ffprobe = @{
        Name = 'b6.1.1-ffprobe-win32-x64'
        Urls = @('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-win32-x64')
        Sha256 = '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4'
        Source = 'https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1'
    }
    ffmpegArchive = @{
        Name = 'ffmpeg-win32-x64.gz'
        Urls = @('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz')
        Sha256 = '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77'
    }
    ffprobeArchive = @{
        Name = 'ffprobe-win32-x64.gz'
        Urls = @('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-win32-x64.gz')
        Sha256 = 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d'
    }
    ffmpegLicense = @{
        Name = 'b6.1.1-win32-x64.LICENSE'
        Urls = @('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.LICENSE')
        Sha256 = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
    }
    ffmpegReadme = @{
        Name = 'b6.1.1-win32-x64.README'
        Urls = @('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.README')
        Sha256 = 'a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311'
    }
    sevenZipStub = @{
        Name = '7zr.exe'
        Urls = @('https://github.com/ip7z/7zip/releases/download/26.06/7zr.exe')
        Sha256 = 'e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc'
    }
    sevenZip = @{
        Name = '7z2606-x64.exe'
        Urls = @('https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.exe')
        Sha256 = '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec'
    }
    inno = @{
        Name = 'innosetup-6.7.4.exe'
        Urls = @('https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe')
        Sha256 = 'a549929319f9120716677c685535ca4671e4b937b5fdc87e2585f32d8eb30e8c'
    }
    webViewSdk = @{
        Name = 'Microsoft.Web.WebView2 1.0.4314.35'
        Urls = @('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg')
        Sha256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
    }
}

function Get-VerifiedAsset($Asset) {
    $file = Join-Path $cache $Asset.Name
    if ((Test-Path -LiteralPath $file -PathType Leaf) -and
        (Get-FileHash -LiteralPath $file).Hash -eq $Asset.Sha256) { return $file }

    $partial = "$file.$([Guid]::NewGuid().ToString('N')).download"
    try {
        foreach ($url in $Asset.Urls) {
            Write-Host "Downloading $($Asset.Name)"
            & $curl --fail --location --silent --show-error --connect-timeout 12 --max-time 180 $url --output $partial
            if ($LASTEXITCODE -ne 0) { continue }
            if ((Get-FileHash -LiteralPath $partial).Hash -ne $Asset.Sha256) {
                Write-Warning "SHA-256 mismatch from $url"
                continue
            }
            Move-Item -LiteralPath $partial -Destination $file -Force
            return $file
        }
        throw "Could not obtain a verified copy of $($Asset.Name)."
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}

function Test-WebViewSignature([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(^|,\s*)CN=Microsoft Corporation(,|$)'
}

function Get-WebViewBootstrapper {
    $file = Join-Path $cache 'MicrosoftEdgeWebview2Setup.exe'
    if (Test-WebViewSignature $file) { return $file }
    $partial = "$file.$([Guid]::NewGuid().ToString('N')).exe"
    try {
        & $curl --fail --location --silent --show-error --connect-timeout 12 --max-time 120 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' --output $partial
        if ($LASTEXITCODE -ne 0 -or -not (Test-WebViewSignature $partial)) {
            throw 'Could not obtain the Microsoft-signed WebView2 Evergreen bootstrapper.'
        }
        Move-Item -LiteralPath $partial -Destination $file -Force
        return $file
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}

function Remove-BuildDirectory([string]$Directory, [string]$Parent) {
    $resolved = (Resolve-Path -LiteralPath $Directory).Path
    $base = (Resolve-Path -LiteralPath $Parent).Path.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the build directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

$starterDirectory = Join-Path $PSScriptRoot 'plugins'
$pluginName = '^[a-z][a-z0-9_]*\.py$'
$starters = @(Get-ChildItem -LiteralPath $starterDirectory -File | Where-Object { $_.Name -cmatch $pluginName })
if (-not $starters) { throw 'No starter search plugins were found.' }
$curated = @()
if ($SearchPluginDirectory) {
    $folder = Get-Item -LiteralPath $SearchPluginDirectory
    if (-not ($folder -is [IO.DirectoryInfo]) -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Supply a regular directory of curated search engine files.'
    }
    $reserved = 'config.py', 'credentials.py', 'helpers.py', 'jackett.py', 'nova2.py', 'nova3.py', 'novaprinter.py', 'prowlarr.py', 'secrets.py', 'settings.py'
    $curated = @(Get-ChildItem -LiteralPath $folder.FullName -File | Where-Object {
        $_.Name -cmatch $pluginName -and $_.Name -notin $reserved
    })
    if (-not $curated) { throw 'No curated search engines were found.' }
    if ($curated | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw 'Curated search engine files must be regular files.'
    }
}
$pluginFiles = $starters + $curated
$duplicate = $pluginFiles | Group-Object Name | Where-Object Count -gt 1 | Select-Object -First 1
if ($duplicate) { throw "Duplicate search engine filename: $($duplicate.Name)" }

$work = Join-Path $buildRoot "build-$([Guid]::NewGuid().ToString('N'))"
$stage = Join-Path $work 'stage'
$runtime = Join-Path $stage 'runtime'
$null = New-Item -ItemType Directory -Path $runtime -Force
try {
    if ($CompilerPath) {
        $compiler = (Resolve-Path -LiteralPath $CompilerPath).Path
    } else {
        $compilerDir = Join-Path $cache 'InnoSetup-6.7.4'
        $compiler = Join-Path $compilerDir 'ISCC.exe'
        if (-not (Test-Path -LiteralPath $compiler)) {
            $innoSetup = Get-VerifiedAsset $assets.inno
            Write-Host 'Preparing the Inno Setup build tool'
            $setup = Start-Process -FilePath $innoSetup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/NOICONS', "/DIR=`"$compilerDir`"" -WindowStyle Hidden -Wait -PassThru
            if ($setup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $compiler)) {
                throw "Inno Setup build tool installation failed ($($setup.ExitCode))."
            }
        }
    }

    $webView = Get-WebViewBootstrapper
    $archiverDir = Join-Path $work '7zip'
    $stub = Get-VerifiedAsset $assets.sevenZipStub
    $sevenZipPackage = Get-VerifiedAsset $assets.sevenZip
    & $stub x -y "-o$archiverDir" $sevenZipPackage '7z.exe' '7z.dll' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the 7-Zip build tool.' }
    $archiver = Join-Path $archiverDir '7z.exe'

    Write-Host 'Staging Cinema and the bundled runtimes'
    & (Join-Path $PSScriptRoot 'Build.ps1') -OutputDirectory $stage | Out-Null
    $desktopSdk = Join-Path $env:LOCALAPPDATA 'Cinema\DesktopBuild\1.0.4314.35'
    if ((Get-FileHash -LiteralPath (Join-Path $desktopSdk 'webview2.zip')).Hash -ne $assets.webViewSdk.Sha256) {
        throw 'The WebView2 SDK archive did not match its pinned SHA-256.'
    }
    foreach ($notice in 'LICENSE.txt', 'NOTICE.txt') {
        Copy-Item -LiteralPath (Join-Path $desktopSdk "sdk\$notice") -Destination (Join-Path $stage "WebView2-$notice")
    }
    Get-ChildItem -LiteralPath $root -Filter '*.mjs' -File | Copy-Item -Destination $stage
    foreach ($name in 'package.json', 'package-lock.json', 'README.md') {
        Copy-Item -LiteralPath (Join-Path $root $name) -Destination $stage
    }
    Copy-Item -LiteralPath (Join-Path $root 'public') -Destination $stage -Recurse

    $nodeArchive = Get-VerifiedAsset $assets.node
    $nodeBuildRoot = Join-Path $work 'node'
    & $archiver x -y "-o$nodeBuildRoot" $nodeArchive | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned Node.js package.' }
    $nodeBuild = Join-Path $nodeBuildRoot 'node-v22.23.4-win-x64'
    $nodeExe = Join-Path $nodeBuild 'node.exe'
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtime 'node.exe')
    Copy-Item -LiteralPath (Join-Path $nodeBuild 'LICENSE') -Destination (Join-Path $runtime 'node-LICENSE.txt')

    $qbitRuntime = Join-Path $runtime 'qbit'
    $null = New-Item -ItemType Directory -Path $qbitRuntime -Force
    if (-not $Online) {
        $qbitPackage = Get-VerifiedAsset $assets.qbit
        & $archiver x -y "-o$qbitRuntime" $qbitPackage 'qbittorrent.exe' 'qt.conf' 'translations\*' | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $qbitRuntime 'qbittorrent.exe'))) {
            throw 'Could not extract the official qBittorrent runtime.'
        }
    }
    Copy-Item -LiteralPath (Get-VerifiedAsset $assets.qbitLicense) -Destination (Join-Path $qbitRuntime 'COPYING')

    $pythonPackage = Get-VerifiedAsset $assets.python
    & $archiver x -y "-o$(Join-Path $runtime 'python')" $pythonPackage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the official Python runtime.' }

    $pluginRuntime = Join-Path $runtime 'plugins'
    $null = New-Item -ItemType Directory -Path $pluginRuntime
    foreach ($plugin in $pluginFiles) {
        Copy-Item -LiteralPath $plugin.FullName -Destination $pluginRuntime
    }

    Write-Host 'Installing locked production JavaScript dependencies'
    Push-Location $stage
    try {
        & $nodeExe (Join-Path $nodeBuild 'node_modules\npm\bin\npm-cli.js') ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    $ffmpegModule = Join-Path $stage 'node_modules\ffmpeg-static'
    Copy-Item -LiteralPath (Get-VerifiedAsset $assets.ffmpegLicense) -Destination (Join-Path $ffmpegModule 'ffmpeg.exe.LICENSE')
    Copy-Item -LiteralPath (Get-VerifiedAsset $assets.ffmpegReadme) -Destination (Join-Path $ffmpegModule 'ffmpeg.exe.README')
    $probeModule = Join-Path $stage 'node_modules\ffprobe-static'
    Remove-BuildDirectory (Join-Path $probeModule 'bin') $stage
    $probeRuntime = Join-Path $probeModule 'bin\win32\x64'
    $null = New-Item -ItemType Directory -Path $probeRuntime -Force
    if (-not $Online) {
        Copy-Item -LiteralPath (Get-VerifiedAsset $assets.ffmpeg) -Destination (Join-Path $ffmpegModule 'ffmpeg.exe')
        Copy-Item -LiteralPath (Get-VerifiedAsset $assets.ffprobe) -Destination (Join-Path $probeRuntime 'ffprobe.exe')
    }
    Copy-Item -LiteralPath (Get-VerifiedAsset $assets.ffmpegLicense) -Destination (Join-Path $probeRuntime 'ffprobe.exe.LICENSE')
    Copy-Item -LiteralPath (Get-VerifiedAsset $assets.ffmpegReadme) -Destination (Join-Path $probeRuntime 'ffprobe.exe.README')

    $provenance = [ordered]@{
        RuntimeDelivery = if ($Online) { 'upstream-on-install' } else { 'bundled' }
        Packages = $assets
        WebView2EvergreenBootstrapper = @{
            Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
            Sha256 = (Get-FileHash -LiteralPath $webView).Hash.ToLowerInvariant()
            Signer = 'Microsoft Corporation'
        }
    }
    if ($curated) {
        $provenance['CuratedSearchPlugins'] = @($curated | ForEach-Object {
            @{ Name = $_.Name; Sha256 = (Get-FileHash -LiteralPath (Join-Path $pluginRuntime $_.Name)).Hash.ToLowerInvariant() }
        })
    }
    $provenance | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'dependency-provenance.json') -Encoding UTF8

    Write-Host 'Compiling the single-file Cinema Setup executable'
    $version = (Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json).version
    $definitions = @("/DAppVersion=$version", "/DStageDir=$stage", "/DWebViewBootstrapper=$webView")
    if ($Online) {
        $definitions += '/DOnlineDependencies=1', "/DQbitFallbackUrl=$($assets.qbit.Urls[1])", "/DQbitMirrorUrl=$($assets.qbit.Urls[2])"
        foreach ($key in 'qbit', 'sevenZipStub', 'sevenZip', 'ffmpegArchive', 'ffprobeArchive', 'ffmpeg', 'ffprobe') {
            $component = $assets[$key]
            $definitions += "/D${key}Name=$($component.Name)", "/D${key}Url=$($component.Urls[0])", "/D${key}Hash=$($component.Sha256)"
        }
    }
    & $compiler /Qp @definitions "/O$work" (Join-Path $PSScriptRoot 'Cinema.iss')
    if ($LASTEXITCODE -ne 0) { throw "Cinema Setup compilation failed ($LASTEXITCODE)." }
    $setupFile = 'Cinema-Setup-x64.exe'
    $destination = Join-Path $OutputDirectory $setupFile
    Move-Item -LiteralPath (Join-Path $work $setupFile) -Destination $destination -Force
    $installer = Get-Item -LiteralPath $destination
    Write-Host "SHA-256: $((Get-FileHash -LiteralPath $installer.FullName).Hash)"
    $installer
} finally {
    Remove-BuildDirectory $work $buildRoot
}
