import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const windowsProgram=`
$ErrorActionPreference="Stop"
$directory=$env:CINEMA_MEMORY_PRIVATE_DIR
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$admins=[Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$allowed=@($user.Value,$system.Value,$admins.Value)

function Assert-PrivateMemoryItem([string]$name,[bool]$isDirectory) {
  $item=Get-Item -LiteralPath $name -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $isDirectory) { throw "Unexpected private storage item" }
  $acl=if($isDirectory){[IO.Directory]::GetAccessControl($name)}else{[IO.File]::GetAccessControl($name)}
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -notin @($user.Value,$admins.Value)) { throw "Unexpected Source Memory owner" }
  if($isDirectory -and !$acl.AreAccessRulesProtected) { throw "The private storage folder inherits access" }
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    $sid=$rule.IdentityReference.Value
    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $sid -notin $allowed) {
      throw "Unexpected grant on Source Memory data"
    }
  }
}

if(!(Test-Path -LiteralPath $directory)){
  if($env:CINEMA_MEMORY_PRIVATE_CREATE -ne "yes"){exit 0}
  $permissions=[Security.AccessControl.DirectorySecurity]::new()
  $permissions.SetAccessRuleProtection($true,$false)
  $permissions.SetOwner($user)
  foreach($identity in @($user,$system,$admins)){
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,"FullControl","ContainerInherit,ObjectInherit","None","Allow")
    $permissions.AddAccessRule($rule)
  }
  [IO.Directory]::CreateDirectory($directory,$permissions)|Out-Null
}
Assert-PrivateMemoryItem $directory $true
foreach($candidate in [IO.Directory]::EnumerateFileSystemEntries($directory)){
  Assert-PrivateMemoryItem $candidate $false
}
`;

export async function prepareSourceMemoryDirectory(directory,create=false){
  let existing;
  try{existing=await fs.lstat(directory);}catch(error){
    if(error.code!=='ENOENT')throw error;
    if(!create)return;
  }
  if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw Error('Source Memory needs a private local folder.');
  if(process.platform==='win32'){
    const windows=process.env.SystemRoot||'C:/Windows';
    const shell=path.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
    await execute(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsProgram,'utf16le').toString('base64')],
      {windowsHide:true,timeout:8000,env:{...process.env,CINEMA_MEMORY_PRIVATE_DIR:directory,
        CINEMA_MEMORY_PRIVATE_CREATE:create?'yes':'no'}}).catch(()=>{throw Error('Cinema could not verify a private folder for Source Memory.');});
    return;
  }
  if(!existing){
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    existing=await fs.lstat(directory);
  }
  const own=process.getuid();
  if(!existing.isDirectory()||existing.uid!==own||(existing.mode&0o077))
    throw Error('Cinema could not verify a private folder for Source Memory.');
  for(const child of await fs.readdir(directory)){
    const item=await fs.lstat(path.join(directory,child));
    if(!item.isFile()||item.uid!==own||(item.mode&0o077))
      throw Error('Cinema could not verify a private folder for Source Memory.');
  }
}
