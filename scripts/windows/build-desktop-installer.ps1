$ErrorActionPreference = "Stop"

. "$PSScriptRoot\resolve-makensis.ps1"
. "$PSScriptRoot\resolve-tauri-version.ps1"

$sourceExe = (Resolve-Path "target/release/shipflow3-tauri.exe").Path
$outputDir = (Resolve-Path "target/release").Path
$outputExe = Join-Path $outputDir "ShipFlow-Desktop-Setup.exe"
$iconFile = (Resolve-Path "src-tauri/icons/icon.ico").Path
$appVersion = Resolve-TauriAppVersion -ConfigPath "src-tauri/tauri.conf.json"
$appVersionQuad = Convert-ToWindowsVersionQuad -Version $appVersion
$makensis = Resolve-Makensis
$duckdbDll = Get-ChildItem -Path "target/release" -Recurse -File -Filter "duckdb.dll" -ErrorAction SilentlyContinue |
  Sort-Object FullName |
  Select-Object -First 1
$duckdbRuntimeDll = Join-Path $outputDir "duckdb.dll"

$makensisArgs = @(
  "/DAPP_VERSION=$appVersion",
  "/DAPP_VERSION_QUAD=$appVersionQuad",
  "/DSOURCE_EXE=$sourceExe",
  "/DOUT_FILE=$outputExe",
  "/DICON_FILE=$iconFile"
)

if ($null -ne $duckdbDll) {
  if ([System.IO.Path]::GetFullPath($duckdbDll.FullName) -ne [System.IO.Path]::GetFullPath($duckdbRuntimeDll)) {
    Copy-Item -Path $duckdbDll.FullName -Destination $duckdbRuntimeDll -Force
  }
  $makensisArgs += "/DDUCKDB_DLL=$((Resolve-Path $duckdbRuntimeDll).Path)"
}

$makensisArgs += "scripts/windows/shipflow-desktop-installer.nsi"

& $makensis @makensisArgs
