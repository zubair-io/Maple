; maple.iss — Inno Setup script for the Maple Windows installer.
;
; Built by .github/workflows/release.yml (choco-installed ISCC on the runner):
;
;   ISCC.exe /DAppVersion=1.2.3 /DPublishDir=<abs path to dotnet publish out> \
;            /DOutputDir=<abs path for the Setup exe> maple.iss
;
; Per-user install (no UAC prompt): PrivilegesRequired=lowest makes {autopf}
; resolve to {localappdata}\Programs. The app payload is the self-contained
; `dotnet publish` folder (WindowsAppSDKSelfContained — no runtime or SDK
; prerequisites). Only {app}\bin goes on the user PATH, and it contains a
; single shim (maple.cmd -> ..\maple-cli.exe), so the app's DLL forest never
; shadows anything in the user's shell.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef PublishDir
  #define PublishDir "..\Maple.WinUI\bin\Release\net8.0-windows10.0.19041.0\win-x64\publish"
#endif
#ifndef OutputDir
  #define OutputDir "Output"
#endif

[Setup]
; Never change AppId — it is how upgrades find the existing install.
AppId={{C184DDCD-C823-4843-9020-B6B08DB331E2}
AppName=Maple
AppVersion={#AppVersion}
AppPublisher=Just Maple
AppPublisherURL=https://justmaple.app
DefaultDirName={autopf}\Maple
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=MapleSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
UninstallDisplayIcon={app}\Maple.WinUI.exe
WizardStyle=modern

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
Source: "maple.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Maple"; Filename: "{app}\Maple.WinUI.exe"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}\bin"; Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

// Strip {app}\bin back out of the user PATH on uninstall.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OrigPath, BinDir: string;
  P: Integer;
begin
  if CurUninstallStep <> usPostUninstall then
    exit;
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', OrigPath) then
    exit;
  BinDir := ExpandConstant('{app}\bin');
  P := Pos(';' + Uppercase(BinDir) + ';', ';' + Uppercase(OrigPath) + ';');
  if P = 0 then
    exit;
  // P is 1-based into the ';'-wrapped string; translate to a delete on the
  // unwrapped original (remove the entry plus one of its separators).
  Delete(OrigPath, P, Length(BinDir) + 1);
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', OrigPath);
end;
