$ErrorActionPreference = "Stop"

$sourceExe = (Resolve-Path "target/release/shipflow3-tauri.exe").Path
$outputDir = (Resolve-Path "target/release").Path
$outputExe = Join-Path $outputDir "ShipFlow-Desktop-Setup.exe"
$iconFile = (Resolve-Path "src-tauri/icons/icon.ico").Path
$makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source

if (-not $makensis) {
  $makensis = Join-Path ${env:ProgramFiles(x86)} "NSIS/makensis.exe"
}

if (-not (Test-Path $makensis)) {
  throw "NSIS makensis.exe was not found. Install NSIS before building the Windows installer."
}

& $makensis `
  "/DAPP_VERSION=0.1.0" `
  "/DSOURCE_EXE=$sourceExe" `
  "/DOUT_FILE=$outputExe" `
  "/DICON_FILE=$iconFile" `
  "scripts/windows/shipflow-desktop-installer.nsi"
