; Vytty portable launcher.
;
; electron-builder's portable .exe unpacks the whole app (~275 MB) to %TEMP% on
; every start and deletes it again on exit, so every launch took 10+ seconds.
; This launcher unpacks each version once, to %LOCALAPPDATA%\Vytty\app\<version>,
; and afterwards just starts it (~1-2 s). It then exits, so the .exe is not held
; open while Vytty runs. Sessions, settings, the vault and logs stay in
; VyttyData next to the .exe (the app finds it through PORTABLE_EXECUTABLE_DIR).
;
; Build: makensis /DVERSION=1.2.3 /DAPP_DIR=dist\win-unpacked /DOUT_FILE=dist\Vytty-1.2.3-portable.exe build\portable.nsi

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
; zlib, not solid: measured first start 6.7 s (141 MB .exe) against 15-34 s for
; LZMA variants (100-104 MB). Later starts do not unpack at all.
SetCompressor zlib

!include "FileFunc.nsh"

Name "Vytty ${VERSION}"
Caption "Vytty"
BrandingText " "
OutFile "${OUT_FILE}"
Icon "icon.ico"
ShowInstDetails nevershow
AutoCloseWindow true
SubCaption 3 " "
SubCaption 4 " "

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Vytty"
VIAddVersionKey "FileDescription" "Vytty terminal"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT License"
VIAddVersionKey "InternalName" "Vytty"
VIAddVersionKey "OriginalFilename" "Vytty-${VERSION}-portable.exe"

Page instfiles

Var appRoot

Function RunApp
  System::Call 'Kernel32::SetEnvironmentVariable(t "PORTABLE_EXECUTABLE_DIR", t "$EXEDIR") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "PORTABLE_EXECUTABLE_FILE", t "$EXEPATH") i'
  ${GetParameters} $R0
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\Vytty.exe" $R0'
FunctionEnd

; Remove cached versions other than this one. A version that is still running
; cannot be renamed (its files are open), so it is left alone.
Function RemoveOldVersions
  FindFirst $R1 $R2 "$appRoot\*"
  loop:
    StrCmp $R2 "" done
    StrCmp $R2 "." next
    StrCmp $R2 ".." next
    StrCmp $R2 "${VERSION}" next
    StrCpy $R3 $R2 "" -6
    StrCmp $R3 ".trash" remove
    StrCpy $R3 $R2 "" -5
    StrCmp $R3 ".part" remove
    ClearErrors
    Rename "$appRoot\$R2" "$appRoot\$R2.trash"
    IfErrors next
    StrCpy $R2 "$R2.trash"
  remove:
    RMDir /r "$appRoot\$R2"
  next:
    FindNext $R1 $R2
    Goto loop
  done:
  FindClose $R1
FunctionEnd

Function .onInit
  StrCpy $appRoot "$LOCALAPPDATA\Vytty\app"
  StrCpy $INSTDIR "$appRoot\${VERSION}"
  ; Already unpacked: start it without showing anything.
  IfFileExists "$INSTDIR\.complete" 0 +3
    Call RunApp
    Quit
FunctionEnd

Section
  DetailPrint "Preparing Vytty ${VERSION} (first start of this version only)..."
  ; Unpack into a temporary folder and rename it when complete, so an
  ; interrupted first start never leaves a half-unpacked version behind.
  RMDir /r "$INSTDIR.part"
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR.part"
  File /r "${APP_DIR}\*.*"
  FileOpen $R0 "$INSTDIR.part\.complete" w
  FileWrite $R0 "${VERSION}"
  FileClose $R0
  SetOutPath "$appRoot"
  ClearErrors
  Rename "$INSTDIR.part" "$INSTDIR"
  IfErrors 0 +3
    MessageBox MB_ICONSTOP "Vytty could not be unpacked to $INSTDIR."
    Abort
  Call RemoveOldVersions
  Call RunApp
SectionEnd
