Unicode true

!ifndef APP_VERSION
!error "APP_VERSION is required"
!endif

!ifndef APP_VERSION_QUAD
!error "APP_VERSION_QUAD is required"
!endif

!ifndef SOURCE_EXE
!error "SOURCE_EXE is required"
!endif

!ifndef OUT_FILE
!define OUT_FILE "ShipFlow-Service-Setup.exe"
!endif

!ifndef ICON_FILE
!define ICON_FILE "..\..\src-tauri\icons\service-icon.ico"
!endif

!define SHIPFLOW_ROOT "C:\ShipFlow"
!define SHIPFLOW_DATA_ROOT "${SHIPFLOW_ROOT}\Data"
!define SHIPFLOW_REG_ROOT "Software\ShipFlow"
!define SHIPFLOW_SERVICE_REG_KEY "${SHIPFLOW_REG_ROOT}\Service"
!define SHIPFLOW_SERVICE_AUTOSTART_VALUE "ShipFlowService"
!define SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE "ShipFlowServiceTray"

Name "ShipFlow Service"
OutFile "${OUT_FILE}"
InstallDir "${SHIPFLOW_ROOT}\Service"
RequestExecutionLevel admin
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"

VIProductVersion "${APP_VERSION_QUAD}"
VIAddVersionKey "ProductName" "ShipFlow Service"
VIAddVersionKey "CompanyName" "ShipFlow"
VIAddVersionKey "FileDescription" "ShipFlow Service Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Page directory
Page instfiles

UninstPage uninstConfirm
UninstPage instfiles

!macro SHIPFLOW_KILL_PROCESS PROCESS_NAME
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${PROCESS_NAME}" /T /F'
!macroend

!macro SHIPFLOW_CLOSE_SERVICE_PROCESSES
  !insertmacro SHIPFLOW_KILL_PROCESS "shipflow-service.exe"
  !insertmacro SHIPFLOW_KILL_PROCESS "ShipFlow Service.exe"
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
  SetRegView 64
  !insertmacro SHIPFLOW_CLOSE_SERVICE_PROCESSES
  !insertmacro SHIPFLOW_PREPARE_DATA_DIRS

  SetOutPath "$INSTDIR"
  File "/oname=shipflow-service.exe" "${SOURCE_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ShipFlow"
  CreateShortcut "$SMPROGRAMS\ShipFlow\ShipFlow Service.lnk" "$INSTDIR\shipflow-service.exe"
  CreateShortcut "$SMPROGRAMS\ShipFlow\Uninstall ShipFlow Service.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\ShipFlow Service.lnk" "$INSTDIR\shipflow-service.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "DisplayName" "ShipFlow Service"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "Publisher" "ShipFlow"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "DisplayIcon" "$INSTDIR\shipflow-service.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "NoRepair" 1

  WriteRegStr HKLM "${SHIPFLOW_SERVICE_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${SHIPFLOW_SERVICE_REG_KEY}" "ExecutablePath" "$INSTDIR\shipflow-service.exe"
  WriteRegStr HKLM "${SHIPFLOW_SERVICE_REG_KEY}" "ProductName" "ShipFlow Service"
  WriteRegStr HKLM "${SHIPFLOW_SERVICE_REG_KEY}" "Version" "${APP_VERSION}"
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  !insertmacro SHIPFLOW_CLOSE_SERVICE_PROCESSES

  Delete "$DESKTOP\ShipFlow Service.lnk"
  Delete "$SMPROGRAMS\ShipFlow\ShipFlow Service.lnk"
  Delete "$SMPROGRAMS\ShipFlow\Uninstall ShipFlow Service.lnk"
  RMDir "$SMPROGRAMS\ShipFlow"

  Delete "$INSTDIR\shipflow-service.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${SHIPFLOW_SERVICE_AUTOSTART_VALUE}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService"
  DeleteRegKey HKLM "${SHIPFLOW_SERVICE_REG_KEY}"
SectionEnd
