var
  ComponentDownloads: TDownloadWizardPage;

procedure InitializeWizard;
begin
  ComponentDownloads := CreateDownloadPage('Downloading Cinema components',
    'Getting qBittorrent and the video tools from their upstream releases.', nil);
  ComponentDownloads.ShowBaseNameInsteadOfUrl := True;
end;

function TryDownloadQbit(const Url: String): Boolean;
begin
  ComponentDownloads.Clear;
  ComponentDownloads.Add(Url, '{#qbitName}', '{#qbitHash}');
  try
    ComponentDownloads.Download;
    Result := True;
  except
    Log(GetExceptionMessage);
    if ComponentDownloads.AbortedByUser then
      RaiseException(GetExceptionMessage);
    Result := False;
  end;
end;

procedure ExtractComponent(const Extractor, Archive, Directory, Files: String);
var
  ExitCode: Integer;
begin
  if not Exec(Extractor, 'x -y -o' + AddQuotes(Directory) + ' ' + AddQuotes(Archive) + ' ' + Files,
      ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    RaiseException('Could not start the archive extractor (Windows error ' + IntToStr(ExitCode) + ').');
  if ExitCode <> 0 then
    RaiseException('Could not extract ' + ExtractFileName(Archive) + ' (error ' + IntToStr(ExitCode) + ').');
end;

procedure ExtractDownloadedComponents;
var
  TempDirectory, ExtractorDirectory, Extractor, VideoTools: String;
begin
  TempDirectory := ExpandConstant('{tmp}\');
  ExtractorDirectory := TempDirectory + 'cinema-extractor';
  Extractor := ExtractorDirectory + '\7z.exe';
  VideoTools := TempDirectory + 'cinema-media';
  ExtractComponent(TempDirectory + '{#sevenZipStubName}', TempDirectory + '{#sevenZipName}',
    ExtractorDirectory, '7z.exe 7z.dll');
  ExtractComponent(Extractor, TempDirectory + '{#qbitName}', TempDirectory + 'cinema-qbit',
    'qbittorrent.exe qt.conf translations\*');
  ExtractComponent(Extractor, TempDirectory + '{#ffmpegArchiveName}', VideoTools, '');
  ExtractComponent(Extractor, TempDirectory + '{#ffprobeArchiveName}', VideoTools, '');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ErrorMessage: String;
begin
  Result := True;
  if CurPageID <> wpReady then
    Exit;

  ComponentDownloads.Show;
  try
    try
      if not TryDownloadQbit('{#qbitUrl}') then
        if not TryDownloadQbit('{#QbitFallbackUrl}') then
          if not TryDownloadQbit('{#QbitMirrorUrl}') then
            RaiseException('The qBittorrent download mirrors could not be reached or verified.');

      ComponentDownloads.Clear;
      ComponentDownloads.Add('{#sevenZipStubUrl}', '{#sevenZipStubName}', '{#sevenZipStubHash}');
      ComponentDownloads.Add('{#sevenZipUrl}', '{#sevenZipName}', '{#sevenZipHash}');
      ComponentDownloads.Add('{#ffmpegArchiveUrl}', '{#ffmpegArchiveName}', '{#ffmpegArchiveHash}');
      ComponentDownloads.Add('{#ffprobeArchiveUrl}', '{#ffprobeArchiveName}', '{#ffprobeArchiveHash}');
      ComponentDownloads.Download;
      ExtractDownloadedComponents;
    except
      Result := False;
      if not ComponentDownloads.AbortedByUser then
      begin
        ErrorMessage := GetExceptionMessage;
        Log(ErrorMessage);
        SuppressibleMsgBox('Cinema could not prepare its download and video tools. ' + ErrorMessage +
          ' Check your internet connection and try again.', mbCriticalError, MB_OK, IDOK);
      end;
    end;
  finally
    ComponentDownloads.Hide;
  end;
end;
