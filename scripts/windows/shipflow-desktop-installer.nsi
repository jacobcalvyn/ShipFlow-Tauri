Unicode true

!ifndef APP_VERSION
!define APP_VERSION "0.1.0"
!endif

!ifndef SOURCE_EXE
!error "SOURCE_EXE is required"
!endif

!ifndef OUT_FILE
!define OUT_FILE "ShipFlow-Desktop-Setup.exe"
!endif

!ifndef ICON_FILE
!define ICON_FILE "..\..\src-tauri\icons\icon.ico"
!endif

!define SHIPFLOW_ROOT "C:\ShipFlow"
!define SHIPFLOW_DATA_ROOT "${SHIPFLOW_ROOT}\Data"

Name "ShipFlow Desktop"
OutFile "${OUT_FILE}"
InstallDir "${SHIPFLOW_ROOT}\Desktop"
RequestExecutionLevel admin
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "ShipFlow Desktop"
VIAddVersionKey "CompanyName" "ShipFlow"
VIAddVersionKey "FileDescription" "ShipFlow Desktop Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Page directory
Page instfiles

UninstPage uninstConfirm
UninstPage instfiles

!macro SHIPFLOW_KILL_PROCESS PROCESS_NAME
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${PROCESS_NAME}" /T /F'
!macroend

!macro SHIPFLOW_CLOSE_DESKTOP_PROCESSES
  !insertmacro SHIPFLOW_KILL_PROCESS "shipflow3-tauri.exe"
  !insertmacro SHIPFLOW_KILL_PROCESS "ShipFlow Desktop.exe"
  Sleep 500
!macroend

!macro SHIPFLOW_PREPARE_DATA_DIRS
  CreateDirectory "${SHIPFLOW_ROOT}"
  CreateDirectory "${SHIPFLOW_DATA_ROOT}"
  CreateDirectory "${SHIPFLOW_DATA_ROOT}\Desktop"
  CreateDirectory "${SHIPFLOW_DATA_ROOT}\Service"
  CreateDirectory "${SHIPFLOW_DATA_ROOT}\Logs"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${SHIPFLOW_DATA_ROOT}" /grant *S-1-5-32-545:(OI)(CI)M /T /C'
!macroend

Section "Install"
  SetShellVarContext all
  !insertmacro SHIPFLOW_CLOSE_DESKTOP_PROCESSES
  !insertmacro SHIPFLOW_PREPARE_DATA_DIRS

  SetOutPath "$INSTDIR"
  File "/oname=shipflow3-tauri.exe" "${SOURCE_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ShipFlow"
  CreateShortcut "$SMPROGRAMS\ShipFlow\ShipFlow Desktop.lnk" "$INSTDIR\shipflow3-tauri.exe"
  CreateShortcut "$SMPROGRAMS\ShipFlow\Uninstall ShipFlow Desktop.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\ShipFlow Desktop.lnk" "$INSTDIR\shipflow3-tauri.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "DisplayName" "ShipFlow Desktop"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "Publisher" "ShipFlow"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "DisplayIcon" "$INSTDIR\shipflow3-tauri.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  !insertmacro SHIPFLOW_CLOSE_DESKTOP_PROCESSES

  Delete "$DESKTOP\ShipFlow Desktop.lnk"
  Delete "$SMPROGRAMS\ShipFlow\ShipFlow Desktop.lnk"
  Delete "$SMPROGRAMS\ShipFlow\Uninstall ShipFlow Desktop.lnk"
  RMDir "$SMPROGRAMS\ShipFlow"

  Delete "$INSTDIR\shipflow3-tauri.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowDesktop"
SectionEnd
