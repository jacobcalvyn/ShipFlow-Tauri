$ErrorActionPreference = "Stop"

. "$PSScriptRoot\resolve-makensis.ps1"
. "$PSScriptRoot\resolve-tauri-version.ps1"

$sourceExe = (Resolve-Path "target/release/shipflow-service.exe").Path
$outputDir = (Resolve-Path "target/release").Path
$outputExe = Join-Path $outputDir "ShipFlow-Service-Setup.exe"
$iconFile = (Resolve-Path "src-tauri/icons/service-icon.ico").Path
$appVersion = Resolve-TauriAppVersion -ConfigPath "apps/service/tauri.conf.json"
$appVersionQuad = Convert-ToWindowsVersionQuad -Version $appVersion
$makensis = Resolve-Makensis

& $makensis `
  "/DAPP_VERSION=$appVersion" `
  "/DAPP_VERSION_QUAD=$appVersionQuad" `
  "/DSOURCE_EXE=$sourceExe" `
  "/DOUT_FILE=$outputExe" `
  "/DICON_FILE=$iconFile" `
  "scripts/windows/shipflow-service-installer.nsi"
