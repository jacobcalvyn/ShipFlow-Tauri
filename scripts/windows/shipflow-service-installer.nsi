Unicode true

!ifndef APP_VERSION
!define APP_VERSION "0.1.0"
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

Name "ShipFlow Service"
OutFile "${OUT_FILE}"
InstallDir "${SHIPFLOW_ROOT}\Service"
RequestExecutionLevel admin
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "ShipFlow Service"
VIAddVersionKey "CompanyName" "ShipFlow"
VIAddVersionKey "FileDescription" "ShipFlow Service Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Page directory
Page instfiles

UninstPage uninstConfirm
UninstPage instfiles

!macro SHIPFLOW_CLOSE_SERVICE_PROCESSES
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM shipflow-service.exe /T /F'
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
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  !insertmacro SHIPFLOW_CLOSE_SERVICE_PROCESSES

  Delete "$DESKTOP\ShipFlow Service.lnk"
  Delete "$SMPROGRAMS\ShipFlow\ShipFlow Service.lnk"
  Delete "$SMPROGRAMS\ShipFlow\Uninstall ShipFlow Service.lnk"
  RMDir "$SMPROGRAMS\ShipFlow"

  Delete "$INSTDIR\shipflow-service.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService"
SectionEnd
