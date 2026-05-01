!macro SHIPFLOW_KILL_PROCESS PROCESS_NAME
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${PROCESS_NAME}" /T /F'
!macroend

!macro SHIPFLOW_CLOSE_DESKTOP_PROCESSES
  !insertmacro SHIPFLOW_KILL_PROCESS "shipflow3-tauri.exe"
  !insertmacro SHIPFLOW_KILL_PROCESS "ShipFlow Desktop.exe"
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SHIPFLOW_CLOSE_DESKTOP_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SHIPFLOW_CLOSE_DESKTOP_PROCESSES
!macroend
