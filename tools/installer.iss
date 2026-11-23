; Nurofen client installer (Inno Setup 6/7).
;
; Build with tools/build-installer.ps1, which embeds only the server address.
;
;   iscc /DServerUrl=http://1.2.3.4:8787 installer.iss

#ifndef ServerUrl
  #define ServerUrl ""
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef ElectronDir
  #define ElectronDir "..\tools\cache\electron-45.4.1"
#endif

[Setup]
AppId={{6F0F9A2C-9E36-4C77-9F4B-5B1B7D3E9C41}
AppName=Nurofen
AppVerName=Nurofen {#AppVersion}
AppVersion={#AppVersion}
AppPublisher=Nurofen
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Nurofen
VersionInfoDescription=Nurofen — установщик клиента
VersionInfoProductName=Nurofen
VersionInfoProductVersion={#AppVersion}
UninstallDisplayName=Nurofen
DefaultDirName={autopf}\Nurofen
DefaultGroupName=Nurofen
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=NurofenSetup
SetupIconFile=..\assets\nurofen.ico
UninstallDisplayIcon={app}\assets\nurofen.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
DisableDirPage=auto
CloseApplications=yes
RestartApplications=no
UsedUserAreasWarning=no
LicenseFile=..\LICENSE
InfoBeforeFile=installer-notes.txt

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "..\client\src\*"; DestDir: "{app}\src"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\client\electron\*"; DestDir: "{app}\electron-app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#ElectronDir}\*"; DestDir: "{app}\electron"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\client\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\client\install.ps1"; DestDir: "{app}\setup"; Flags: ignoreversion
Source: "..\client\uninstall.ps1"; DestDir: "{app}\setup"; Flags: ignoreversion
Source: "..\assets\nurofen.ico"; DestDir: "{app}\assets"; Flags: ignoreversion

[Icons]
Name: "{group}\Nurofen"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\electron-app"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\assets\nurofen.ico"; Comment: "Nurofen — виртуальная локальная сеть"; \
  Check: ElectronExists
Name: "{autodesktop}\Nurofen"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\electron-app"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\assets\nurofen.ico"; Comment: "Nurofen — виртуальная локальная сеть"; \
  Check: ElectronExists
Name: "{commonstartup}\Nurofen"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\electron-app"" --hidden"; \
  WorkingDir: "{app}"; IconFilename: "{app}\assets\nurofen.ico"; Comment: "Nurofen — автозапуск в трее"; \
  Check: ElectronExists

[Registry]
Root: HKCU; Subkey: "Software\Classes\nurofen"; ValueType: string; ValueName: ""; ValueData: "URL:Nurofen invite link"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\nurofen"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\nurofen\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\assets\nurofen.ico"
Root: HKCU; Subkey: "Software\Classes\nurofen\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\electron\electron.exe"" ""{app}\electron-app"" ""%1"""

[Run]
Filename: "{app}\electron\electron.exe"; Parameters: """{app}\electron-app"""; WorkingDir: "{app}"; \
  Description: "Запустить Nurofen"; Flags: nowait postinstall skipifsilent runasoriginaluser; \
  Check: ElectronExists

[InstallDelete]
Type: files; Name: "{app}\src\minecraft.js"
Type: files; Name: "{app}\src\nbt.js"
Type: files; Name: "{app}\src\servers.js"
Type: files; Name: "{app}\Nurofen.vbs"
Type: files; Name: "{app}\NurofenBackground.vbs"

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup\uninstall.ps1"" -KeepFiles -InstallDir ""{app}"""; \
  RunOnceId: "NurofenHelper"; Flags: runhidden waituntilterminated

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\electron-app"
Type: filesandordirs; Name: "{app}\electron"
Type: files; Name: "{app}\defaults.json"
Type: files; Name: "{app}\Nurofen.vbs"
Type: files; Name: "{app}\NurofenBackground.vbs"
Type: files; Name: "{app}\setup.log"
Type: dirifempty; Name: "{app}"

[Code]
function LauncherExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\Nurofen.vbs'));
end;

function ElectronExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\electron\electron.exe')) and
            FileExists(ExpandConstant('{app}\electron-app\main.js'));
end;

function RunClientSetup(): Boolean;
var
  Params: String;
  ResultCode: Integer;
begin
  Params :=
    '/c ""powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\setup\install.ps1') + '"' +
    ' -NoCopy -NoLaunch -NoAutostart -NoShortcuts -InstallDir "' + ExpandConstant('{app}') + '"' +
    ' -Server "{#ServerUrl}"' +
    ' > "' + ExpandConstant('{app}\setup.log') + '" 2>&1"';

  Result :=
    Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and
    (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Настраиваю туннель: Node.js, AmneziaWG, служба-помощник…';
    if not RunClientSetup() then
      MsgBox('Не удалось доустановить компоненты Nurofen.' + #13#10 + #13#10 +
             'Что делать: посмотрите журнал ' + ExpandConstant('{app}\setup.log') +
             ' — чаще всего это недоступный интернет при скачивании Node.js или AmneziaWG.' + #13#10 + #13#10 +
             'Программу можно удалить в «Программы и компоненты».',
             mbError, MB_OK);
  end;
end;
