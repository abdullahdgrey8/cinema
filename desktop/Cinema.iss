#define AppName "Cinema Player"
#define AppExe "Cinema.exe"

[Setup]
AppId={{BE5E8BAF-6332-4BB9-8119-16C05C8FA5A5}
AppName={#AppName}
AppVersion={#AppVersion}
AppMutex=Local\CinemaDesktop.Installed.Instance
AppPublisher=Cinema
AppPublisherURL=https://github.com/abdullahdgrey8/cinema
AppSupportURL=https://github.com/abdullahdgrey8/cinema/issues
DefaultDirName={localappdata}\Programs\Cinema Player
DefaultGroupName={#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableFinishedPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
SetupIconFile=..\cinema.ico
UninstallDisplayIcon={app}\{#AppExe}
OutputBaseFilename=Cinema-Setup-x64
WizardStyle=modern
Compression=lzma2/normal
SolidCompression=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Files]
Source: "{#WebViewBootstrapper}"; Flags: dontcopy
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef OnlineDependencies
Source: "{tmp}\cinema-qbit\qbittorrent.exe"; DestDir: "{app}\runtime\qbit"; ExternalSize: 42607104; Flags: external ignoreversion
Source: "{tmp}\cinema-qbit\qt.conf"; DestDir: "{app}\runtime\qbit"; ExternalSize: 84; Flags: external ignoreversion
Source: "{tmp}\cinema-qbit\translations\*.qm"; DestDir: "{app}\runtime\qbit\translations"; Flags: external ignoreversion
Source: "{tmp}\cinema-media\ffmpeg-win32-x64"; DestDir: "{app}\node_modules\ffmpeg-static"; DestName: "ffmpeg.exe"; ExternalSize: 82797568; Hash: "{#ffmpegHash}"; Flags: external ignoreversion
Source: "{tmp}\cinema-media\ffprobe-win32-x64"; DestDir: "{app}\node_modules\ffprobe-static\bin\win32\x64"; DestName: "ffprobe.exe"; ExternalSize: 82668032; Hash: "{#ffprobeHash}"; Flags: external ignoreversion
#endif

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: """{app}"" --installed"; WorkingDir: "{app}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: """{app}"" --installed"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Parameters: """{app}"" --installed"; WorkingDir: "{app}"; Flags: nowait skipifsilent

[Code]
const
  WebViewKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebViewSetup = 'MicrosoftEdgeWebview2Setup.exe';

#ifdef OnlineDependencies
#include "CinemaOnline.iss"
#endif

function HasWebViewVersion(RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, WebViewKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function HasWebViewRuntime: Boolean;
begin
  Result := HasWebViewVersion(HKLM32) or HasWebViewVersion(HKCU);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := PageID = wpSelectTasks;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if HasWebViewRuntime then
    Exit;

  WizardForm.StatusLabel.Caption := 'Installing Microsoft Edge WebView2…';
  ExtractTemporaryFile(WebViewSetup);
  if not Exec(ExpandConstant('{tmp}\' + WebViewSetup), '/silent /install', '',
      SW_HIDE, ewWaitUntilTerminated, ExitCode) then
  begin
    Result := 'Setup could not start the Microsoft Edge WebView2 installer. Windows error ' + IntToStr(ExitCode) + '.';
    Exit;
  end;

  if not HasWebViewRuntime then
    Result := 'Microsoft Edge WebView2 could not be installed. Connect to the internet and run Cinema Setup again. Microsoft installer exit code ' + IntToStr(ExitCode) + '.';
end;
