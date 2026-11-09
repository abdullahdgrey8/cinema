[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BundlePath,
    [Parameter(Mandatory)][string]$OpenSslPath,
    [string]$ProfileRoot,
    [ValidateRange(1024, 65535)][int]$WebPort = 42971,
    [ValidateRange(1024, 65535)][int]$PeerPort = 42972,
    [switch]$PrivateFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Exact runtime from the independently verified native Windows scene build.
$runtimeHashes = [ordered]@{
    'libb2-1.dll' = '01bbf64090367d511f41d9fc8f34c557f61d4a227b7c9e47ce04052cbfdc3e7d'
    'libbrotlicommon.dll' = '7b0047dc16dd92a7932124dfd5a6e698d342f533a15d37d61f710def66091436'
    'libbrotlidec.dll' = 'c4c987a01597ddf969d93023f933f999a20f285588b0decb4deeb780c9e9cdf8'
    'libcrypto-3-x64.dll' = '97308feea369b305e562c0098638a1b02a06f52ee9fcc4b8cf3da362ff563cf4'
    'libdouble-conversion.dll' = 'aecc5a09c4657a969be2969269029664898b3d1ac037b0795614d685a7ca6c1e'
    'libgcc_s_seh-1.dll' = '791ebf66e99c7c1b4ed3666468cec45a0172b4c8942ac6c84c3e9cab3e1b5270'
    'libicudt78.dll' = '29b2f925adf4531d7b3ee0edc037f3559996de499dff663819f07000a79d72fa'
    'libicuin78.dll' = 'cb87dfb05ae183ea96f2295174d993430094cc0f0d6ba99fd4f253d5079b0890'
    'libicuuc78.dll' = '9d5fd51a4647f759067568ae82dc391b56af144966a588cd98aab77ef045835a'
    'libpcre2-16-0.dll' = '5c8e23edd85dc6593120746f606eed6c0ddcf682d658422ee0d2d5a754fbca42'
    'libsqlite3-0.dll' = '0b8ecbefff0fda8c6f8562f896df0935842396bff20bb746602b115172f3d526'
    'libssl-3-x64.dll' = '8b71cd694f8edfbddc76674111278db6bcdcde0dcd63b99238420193848e6dbf'
    'libstdc++-6.dll' = '4e4822dc4aaa99383f581dae7ab9464ae89346c5ca742f7efbcdebe20b0fe7b5'
    'libwinpthread-1.dll' = '94a9a4e2fe27b4bc827a4b209e9deb4cc3dc34bc025df06b849144f9d4c588f8'
    'libz-1.dll' = '934103c50623302548a1cf66fbc22f0029e4eb4556343252a505e2fc005e835f'
    'libzstd.dll' = '48368ab0ca622d0ec12f41ce85d91f22866bf5da92c77a69a06483564c93816c'
    'plugins\sqldrivers\qsqlite.dll' = 'e5decaab142004f70695e50b028fb80efac8c401be2c2809b2108ab85bed4a11'
    'plugins\tls\qcertonlybackend.dll' = '8a67776e89074ce8bd389f0abd0b7bd68637e7e33278ddbceaf978b9d3d44547'
    'plugins\tls\qopensslbackend.dll' = 'ee860823771613562e3fcc55aa194df363cb979f73a11dc215d6a214ce6a5c88'
    'plugins\tls\qschannelbackend.dll' = 'b677ba5df631db8f402026f52d07732c2c2287693d736999fb16531b0af1e915'
    'qbittorrent-nox.exe' = 'edc19c0599648f97369fb87f3b965e493c1e790c6259fb4f564e99e275927cef'
    'qt.conf' = '52ed9add5c4def7a30c99bc18714f9f9c560acd10801f495a59cd60b51cdce3b'
    'Qt6Core.dll' = 'bcfa6e5a8996340bd2b3a633629f97114e018f73658f15848e6a9e82645c386c'
    'Qt6Network.dll' = 'ee96fdb6b33a12f485506ba2da247165858bcc6d9e755e1c66e4af6f862e5496'
    'Qt6Sql.dll' = '7c6643500be85a077b5d03d8b8550e648193976997030b9e39061fd226441664'
    'Qt6Xml.dll' = '037ed8e2661a63919e163130730ae3b61cbcfbc7b9952afc93b6c9e66af8cea3'
    'zlib1.dll' = 'aa658771fb152b095eda1614d8bde798efb92324b6f4a0c99c743cd96b67ac90'
}
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Get-DrivePath([string]$value) {
    if ($value -notmatch '^[a-zA-Z]:[\\/]' -or $value -match '(^|[\\/])\.\.?([\\/]|$)') {
        throw 'Setup requires absolute local paths without traversal.'
    }
    $absolute = [IO.Path]::GetFullPath($value)
    if ($absolute -eq [IO.Path]::GetPathRoot($absolute)) { return $absolute }
    return $absolute.TrimEnd([char[]]'\/')
}

function Get-PlainItem([string]$itemPath, [bool]$directory) {
    $item = Get-Item -LiteralPath $itemPath -Force
    if ($item.PSIsContainer -ne $directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Setup requires an ordinary filesystem item at $itemPath."
    }
    return $item
}

function Assert-PlainDirectories([string]$directory) {
    $item = [IO.DirectoryInfo]::new($directory)
    while ($null -ne $item) {
        [void](Get-PlainItem $item.FullName $true)
        $item = $item.Parent
    }
}

function Assert-StagingTree([string]$stage, [string]$parent) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ine $parent -or
        [IO.Path]::GetFileName($stage) -cnotmatch '^\.scene-companion-stage-[a-f0-9]{32}$') {
        throw 'The staging directory is outside the expected Cinema setup location.'
    }
    Assert-PlainDirectories $parent
    [void](Get-PlainItem $stage $true)
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($stage)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Setup encountered a reparse point in its staging directory.'
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function Protect-StagingDirectory([string]$directory, [Security.Principal.SecurityIdentifier]$owner) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($owner)
    $security.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($identity in $owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
        $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $security
}

function New-PrivateCertificate([string]$exe, [string]$directory) {
    $configuration = @'
[req]
distinguished_name = subject
prompt = no
x509_extensions = server_tls
[subject]
CN = 127.0.0.1
[server_tls]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
'@
    $configurationPath = Join-Path $directory 'openssl.cnf'
    [IO.File]::WriteAllText($configurationPath, $configuration, $utf8)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $exe
    $start.WorkingDirectory = $directory
    $start.Arguments = 'req -new -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -config openssl.cnf -keyout key.pem -out cert.pem'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'OpenSSL did not finish creating the loopback identity.'
        }
        [void]$output.GetAwaiter().GetResult()
        [void]$errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'OpenSSL could not create the loopback identity.' }
    } finally {
        $process.Dispose()
    }
    [IO.File]::Delete($configurationPath)
    foreach ($name in 'cert.pem', 'key.pem') {
        $file = Get-PlainItem (Join-Path $directory $name) $false
        if ($file.Length -lt 1 -or $file.Length -gt 16384) { throw 'OpenSSL returned an invalid loopback identity.' }
    }
}

function New-RandomBytes([int]$count) {
    $bytes = [byte[]]::new($count)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) }
    finally { $random.Dispose() }
    return ,$bytes
}

function ConvertTo-Hex([byte[]]$bytes) {
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Format-SettingsPath([string]$itemPath) {
    return '"' + $itemPath.Replace('\', '/') + '"'
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This setup requires Windows.' }
if ($WebPort -eq $PeerPort -or $WebPort -in 3210, 3212, 6881, 8080 -or $PeerPort -in 3210, 3212, 6881, 8080) {
    throw 'Choose two distinct companion ports outside the stock and Cinema service ports.'
}

$userProfile = Get-DrivePath ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))
Assert-PlainDirectories $userProfile
$cinemaRoot = Join-Path $userProfile 'CinemaData'
if (!$ProfileRoot) { $ProfileRoot = Join-Path $cinemaRoot 'SceneCompanion' }
$target = Get-DrivePath $ProfileRoot
$targetName = [IO.Path]::GetFileName($target)
if ([IO.Path]::GetDirectoryName($target) -ine $cinemaRoot -or
    $targetName -cnotmatch '^SceneCompanion(?:-qa-[a-zA-Z0-9][a-zA-Z0-9-]{0,63})?$') {
    throw 'Choose SceneCompanion or a SceneCompanion-qa-* directory directly under CinemaData in your Windows profile.'
}
if ($PrivateFixture -and $targetName -ceq 'SceneCompanion') {
    throw 'Private fixture networking is available only in a QA profile.'
}

$bundle = Get-DrivePath $BundlePath
$openssl = Get-DrivePath $OpenSslPath
foreach ($directory in $bundle, (Join-Path $bundle 'plugins\sqldrivers'), (Join-Path $bundle 'plugins\tls'),
    ([IO.Path]::GetDirectoryName($openssl))) {
    Assert-PlainDirectories $directory
}
[void](Get-PlainItem $openssl $false)
if ([IO.Path]::GetExtension($openssl) -ine '.exe') { throw 'Choose an explicit OpenSSL executable.' }

[void][IO.Directory]::CreateDirectory($cinemaRoot)
Assert-PlainDirectories $cinemaRoot
if (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue) {
    throw 'This companion profile already exists. Setup creates only a new profile.'
}

$windowsUser = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $owner = $windowsUser.User }
finally { $windowsUser.Dispose() }
$stage = Join-Path $cinemaRoot ('.scene-companion-stage-' + [Guid]::NewGuid().ToString('N'))
$stageCreated = $false
$published = $false
try {
    [void](New-Item -ItemType Directory -Path $stage)
    $stageCreated = $true
    Protect-StagingDirectory $stage $owner
    foreach ($directory in 'runtime', 'identity', 'qbit-profile\qBittorrent\config', 'app-data', 'downloads', 'incomplete') {
        [void][IO.Directory]::CreateDirectory((Join-Path $stage $directory))
    }
    foreach ($entry in $runtimeHashes.GetEnumerator()) {
        $source = Join-Path $bundle $entry.Key
        $destination = Join-Path $stage ("runtime\" + $entry.Key)
        [void](Get-PlainItem $source $false)
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        [IO.File]::Copy($source, $destination, $false)
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $entry.Value) {
            throw "The native runtime verification failed for $($entry.Key)."
        }
    }
    New-PrivateCertificate $openssl (Join-Path $stage 'identity')
    $password = ConvertTo-Hex (New-RandomBytes 24)
    $sceneKey = ConvertTo-Hex (New-RandomBytes 32)
    $salt = New-RandomBytes 16
    $deriver = [Security.Cryptography.Rfc2898DeriveBytes]::new($password, $salt, 100000,
        [Security.Cryptography.HashAlgorithmName]::SHA512)
    try { $derived = $deriver.GetBytes(64) }
    finally { $deriver.Dispose() }
    $passwordHash = [Convert]::ToBase64String($salt) + ':' + [Convert]::ToBase64String($derived)
    $ini = @(
        '[LegalNotice]'
        'Accepted=true'
        '[Preferences]'
        'WebUI\Enabled=true'
        'WebUI\Address=127.0.0.1'
        "WebUI\Port=$WebPort"
        'WebUI\LocalHostAuth=true'
        'WebUI\AuthSubnetWhitelistEnabled=false'
        'WebUI\Username=cinema'
        "WebUI\Password_PBKDF2=@ByteArray($passwordHash)"
        'WebUI\ServerDomains=127.0.0.1'
        'WebUI\CSRFProtection=true'
        'WebUI\HostHeaderValidation=true'
        'WebUI\SecureCookie=true'
        'WebUI\ReverseProxySupportEnabled=false'
        'WebUI\HTTPS\Enabled=true'
        ('WebUI\HTTPS\CertificatePath=' + (Format-SettingsPath (Join-Path $target 'identity\cert.pem')))
        ('WebUI\HTTPS\KeyPath=' + (Format-SettingsPath (Join-Path $target 'identity\key.pem')))
        '[BitTorrent]'
        "Session\Port=$PeerPort"
        ('Session\DefaultSavePath=' + (Format-SettingsPath (Join-Path $target 'downloads')))
        ('Session\TempPath=' + (Format-SettingsPath (Join-Path $target 'incomplete')))
        'Session\TempPathEnabled=true'
    )
    if ($PrivateFixture) {
        $ini += 'Session\InterfaceAddress=127.0.0.1', 'Session\DHTEnabled=false', 'Session\LSDEnabled=false',
            'Session\PeXEnabled=false', '[Network]', 'PortForwardingEnabled=false'
    }
    [IO.File]::WriteAllLines((Join-Path $stage 'qbit-profile\qBittorrent\config\qBittorrent.ini'), [string[]]$ini, $utf8)
    $profile = [ordered]@{
        schema = 1
        webPort = $WebPort
        peerPort = $PeerPort
        password = $password
        sceneKey = $sceneKey
        ownerSid = $owner.Value
        certificateSha256 = (Get-FileHash -LiteralPath (Join-Path $stage 'identity\cert.pem') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText((Join-Path $stage 'profile.json'), (ConvertTo-Json -InputObject $profile), $utf8)
    Assert-StagingTree $stage $cinemaRoot
    [IO.Directory]::Move($stage, $target)
    $published = $true
    Write-Output "Cinema Scene Preview is provisioned at $target."
} finally {
    if ($stageCreated -and !$published -and (Test-Path -LiteralPath $stage)) {
        Assert-StagingTree $stage $cinemaRoot
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
