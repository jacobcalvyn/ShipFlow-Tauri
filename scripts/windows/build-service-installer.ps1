$ErrorActionPreference = "Stop"

. "$PSScriptRoot\resolve-makensis.ps1"

$sourceExe = (Resolve-Path "target/release/shipflow-service.exe").Path
$outputDir = (Resolve-Path "target/release").Path
$outputExe = Join-Path $outputDir "ShipFlow-Service-Setup.exe"
$iconFile = (Resolve-Path "src-tauri/icons/service-icon.ico").Path
$makensis = Resolve-Makensis

& $makensis `
  "/DAPP_VERSION=0.1.0" `
  "/DSOURCE_EXE=$sourceExe" `
  "/DOUT_FILE=$outputExe" `
  "/DICON_FILE=$iconFile" `
  "scripts/windows/shipflow-service-installer.nsi"
