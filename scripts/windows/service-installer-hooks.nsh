!macro SHIPFLOW_KILL_PROCESS PROCESS_NAME
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${PROCESS_NAME}" /T /F'
!macroend

!macro SHIPFLOW_CLOSE_SERVICE_PROCESSES
  !insertmacro SHIPFLOW_KILL_PROCESS "shipflow-service.exe"
  !insertmacro SHIPFLOW_KILL_PROCESS "ShipFlow Service.exe"
  Sleep 500
!macroend

!define SHIPFLOW_SERVICE_AUTOSTART_VALUE "ShipFlowService"
!define SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE "ShipFlowServiceTray"

!macro SHIPFLOW_REMOVE_SERVICE_AUTOSTART_VALUES
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${SHIPFLOW_SERVICE_AUTOSTART_VALUE}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SHIPFLOW_CLOSE_SERVICE_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SHIPFLOW_CLOSE_SERVICE_PROCESSES
  !insertmacro SHIPFLOW_REMOVE_SERVICE_AUTOSTART_VALUES
!macroend
