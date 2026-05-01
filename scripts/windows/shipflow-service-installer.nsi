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

Name "ShipFlow Service"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\ShipFlow Service"
RequestExecutionLevel user
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

Section "Install"
  SetOutPath "$INSTDIR"
  File "/oname=shipflow-service.exe" "${SOURCE_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ShipFlow Service"
  CreateShortcut "$SMPROGRAMS\ShipFlow Service\ShipFlow Service.lnk" "$INSTDIR\shipflow-service.exe"
  CreateShortcut "$SMPROGRAMS\ShipFlow Service\Uninstall ShipFlow Service.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\ShipFlow Service.lnk" "$INSTDIR\shipflow-service.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "DisplayName" "ShipFlow Service"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "Publisher" "ShipFlow"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "DisplayIcon" "$INSTDIR\shipflow-service.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\ShipFlow Service.lnk"
  Delete "$SMPROGRAMS\ShipFlow Service\ShipFlow Service.lnk"
  Delete "$SMPROGRAMS\ShipFlow Service\Uninstall ShipFlow Service.lnk"
  RMDir "$SMPROGRAMS\ShipFlow Service"

  Delete "$INSTDIR\shipflow-service.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ShipFlowService"
SectionEnd
