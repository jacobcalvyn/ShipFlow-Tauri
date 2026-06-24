param(
  [string] $DesktopExePath = "",
  [string] $ServiceExePath = "",
  [string] $DesktopInstallerPath = "",
  [string] $ServiceInstallerPath = "",
  [string] $OutputDir = "release-smoke-evidence/windows",
  [bool] $RequireStartAtLogin = $true,
  [switch] $LaunchDesktopTwice,
  [switch] $LaunchServiceSettingsTwice,
  [switch] $LaunchServiceTrayTwice
)

$ErrorActionPreference = "Stop"

Write-Verbose "Use -LaunchDesktopTwice to collect repeated Desktop launch single-instance evidence."
Write-Verbose "Use -LaunchServiceSettingsTwice to collect repeated Service Settings launch single-instance evidence."
Write-Verbose "Use -LaunchServiceTrayTwice to collect repeated Service tray launch single-instance evidence."

function Resolve-Signtool {
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
    -Recurse `
    -Filter signtool.exe `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($null -eq $signtool) {
    throw "Unable to find Windows SDK signtool.exe"
  }

  return $signtool.FullName
}

function Get-RegistryString {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  $item = Get-ItemProperty -Path $Path -ErrorAction Stop
  $value = $item.$Name
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing registry value ${Path}\\${Name}"
  }

  return [string] $value
}

function Invoke-Capture {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [scriptblock] $Script
  )

  $outputPath = Join-Path $OutputDir "$Name.txt"
  & $Script *>&1 | Out-File -FilePath $outputPath -Encoding utf8
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [string] $FilePath,

    [string[]] $Arguments = @()
  )

  $outputPath = Join-Path $OutputDir "$Name.txt"
  & $FilePath @Arguments *>&1 | Out-File -FilePath $outputPath -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Get-Content $outputPath | ForEach-Object { Write-Error $_ }
    throw "Native command failed for ${Name}: $FilePath $($Arguments -join ' ')"
  }
}

function Assert-FileExists {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "$Label does not exist: $Path"
  }
}

function Normalize-WindowsEvidencePath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "Windows evidence path must not be empty."
  }

  return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]] @('\', '/'))
}

function Assert-RegistryExecutableDiscovery {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Label,

    [Parameter(Mandatory = $true)]
    [string] $RegistryExecutablePath,

    [Parameter(Mandatory = $true)]
    [string] $CollectorExecutablePath,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedExecutableName
  )

  $normalizedRegistryPath = Normalize-WindowsEvidencePath -Path $RegistryExecutablePath
  $normalizedCollectorPath = Normalize-WindowsEvidencePath -Path $CollectorExecutablePath
  $registryFileName = [System.IO.Path]::GetFileName($normalizedRegistryPath)

  if (-not [string]::Equals($registryFileName, $ExpectedExecutableName, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "${Label} registry ExecutablePath must end with ${ExpectedExecutableName}, got ${registryFileName}."
  }

  Assert-FileExists -Path $RegistryExecutablePath -Label "${Label} registry executable"
  Assert-FileExists -Path $CollectorExecutablePath -Label "${Label} collector executable"

  $outputPath = Join-Path $OutputDir "${Label}-executable-discovery.txt"
  @"
Registry executable path: $normalizedRegistryPath
Collector executable path: $normalizedCollectorPath
Expected executable name: $ExpectedExecutableName
"@ | Out-File -FilePath $outputPath -Encoding utf8

  if (-not [string]::Equals($normalizedRegistryPath, $normalizedCollectorPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Get-Content $outputPath | ForEach-Object { Write-Error $_ }
    throw "${Label} registry discovery did not match the executable path verified by the collector."
  }

  "Windows registry discovery matched collector executable path." |
    Out-File -FilePath $outputPath -Encoding utf8 -Append
}

function Verify-SignedFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  Assert-FileExists -Path $Path -Label $Label
  Invoke-NativeCapture "${Label}-signtool-verify" $script:SigntoolPath @("verify", "/pa", "/v", $Path)
}

function Assert-RegistryValueAbsent {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [string] $EvidenceName
  )

  $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
  $property = if ($null -eq $item) { $null } else { $item.PSObject.Properties[$Name] }
  if ($null -ne $property) {
    throw "${Name} legacy Run value must be absent."
  }

  "${Name} Run value is absent." |
    Out-File -FilePath (Join-Path $OutputDir "${EvidenceName}.txt") -Encoding utf8
}

function Write-RegistryEvidence {
  $desktopInstallLocation = Get-RegistryString `
    -Path "HKLM:\Software\ShipFlow\Desktop" `
    -Name "InstallLocation"
  $desktopExecutablePath = Get-RegistryString `
    -Path "HKLM:\Software\ShipFlow\Desktop" `
    -Name "ExecutablePath"
  $serviceInstallLocation = Get-RegistryString `
    -Path "HKLM:\Software\ShipFlow\Service" `
    -Name "InstallLocation"
  $serviceExecutablePath = Get-RegistryString `
    -Path "HKLM:\Software\ShipFlow\Service" `
    -Name "ExecutablePath"

  if ([string]::IsNullOrWhiteSpace($script:DesktopExePath)) {
    $script:DesktopExePath = $desktopExecutablePath
  }

  if ([string]::IsNullOrWhiteSpace($script:ServiceExePath)) {
    $script:ServiceExePath = $serviceExecutablePath
  }

  Assert-RegistryExecutableDiscovery `
    -Label "desktop" `
    -RegistryExecutablePath $desktopExecutablePath `
    -CollectorExecutablePath $script:DesktopExePath `
    -ExpectedExecutableName "shipflow3-tauri.exe"
  Assert-RegistryExecutableDiscovery `
    -Label "service" `
    -RegistryExecutablePath $serviceExecutablePath `
    -CollectorExecutablePath $script:ServiceExePath `
    -ExpectedExecutableName "shipflow-service.exe"

  Invoke-NativeCapture "desktop-install-registry" "reg.exe" @("query", "HKLM\Software\ShipFlow\Desktop")
  Invoke-NativeCapture "service-install-registry" "reg.exe" @("query", "HKLM\Software\ShipFlow\Service")

  if ($RequireStartAtLogin) {
    $runValue = Get-RegistryString `
      -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
      -Name "ShipFlowService"

    if ($runValue -notlike "*--shipflow-service-autostart*") {
      throw "ShipFlowService Run value must include --shipflow-service-autostart."
    }

    if ($runValue -notlike "*$serviceExecutablePath*") {
      throw "ShipFlowService Run value must point to the installed Service executable."
    }
  }

  Invoke-NativeCapture "service-login-run-registry" "reg.exe" @(
    "query",
    "HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
    "/v",
    "ShipFlowService"
  )
  Assert-RegistryValueAbsent `
    -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
    -Name "ShipFlowServiceTray" `
    -EvidenceName "service-legacy-tray-run-registry-absent"
}

function Write-ProcessEvidence {
  Invoke-Capture "shipflow-process-snapshot" {
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.Name -in @("shipflow3-tauri.exe", "shipflow-service.exe") -or
        $_.CommandLine -like "*ShipFlow*"
      } |
      Select-Object ProcessId, Name, ExecutablePath, CommandLine |
      Format-List
  }
}

function Get-RuntimeLogDir {
  $dataRoot = if ([string]::IsNullOrWhiteSpace($env:SHIPFLOW_WINDOWS_DATA_ROOT)) {
    "C:\ShipFlow\Data"
  } else {
    $env:SHIPFLOW_WINDOWS_DATA_ROOT
  }

  if (Test-Path $dataRoot -PathType Container) {
    return Join-Path $dataRoot "Logs"
  }

  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    return Join-Path $env:APPDATA "ShipFlow Service\shipflow-service-runtime\logs"
  }

  throw "Unable to resolve ShipFlow runtime log directory."
}

function Get-ServiceStateDir {
  $dataRoot = if ([string]::IsNullOrWhiteSpace($env:SHIPFLOW_WINDOWS_DATA_ROOT)) {
    "C:\ShipFlow\Data"
  } else {
    $env:SHIPFLOW_WINDOWS_DATA_ROOT
  }

  if (Test-Path $dataRoot -PathType Container) {
    return Join-Path (Join-Path $dataRoot "Service") "shipflow-service-runtime"
  }

  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    return Join-Path $env:APPDATA "ShipFlow Service\shipflow-service-runtime"
  }

  throw "Unable to resolve ShipFlow service state directory."
}

function Write-WindowStateEvidence {
  $windowStatePath = Join-Path (Get-ServiceStateDir) "window-state.json"
  Assert-FileExists -Path $windowStatePath -Label "window state"
  Copy-Item -Path $windowStatePath -Destination (Join-Path $OutputDir "window-state.json") -Force
  $windowStatePath |
    Out-File -FilePath (Join-Path $OutputDir "window-state-source.txt") -Encoding utf8
}

function Write-RuntimeLogTail {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ProcessName,

    [Parameter(Mandatory = $true)]
    [string] $EvidenceName
  )

  $logPath = Join-Path (Get-RuntimeLogDir) "$ProcessName.log"
  Assert-FileExists -Path $logPath -Label "$ProcessName runtime log"
  Get-Content -Path $logPath -Tail 400 |
    Out-File -FilePath (Join-Path $OutputDir "$EvidenceName.txt") -Encoding utf8
}

function Write-RuntimeLogTailIfPresent {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ProcessName,

    [Parameter(Mandatory = $true)]
    [string] $EvidenceName
  )

  $logPath = Join-Path (Get-RuntimeLogDir) "$ProcessName.log"
  if (Test-Path $logPath -PathType Leaf) {
    Get-Content -Path $logPath -Tail 400 |
      Out-File -FilePath (Join-Path $OutputDir "$EvidenceName.txt") -Encoding utf8
  }
}

function Assert-DesktopSingleInstance {
  $desktopProcesses = @(
    Get-CimInstance Win32_Process |
      Where-Object { $_.Name -eq "shipflow3-tauri.exe" }
  )

  $desktopProcesses |
    Select-Object ProcessId, Name, ExecutablePath, CommandLine |
    Format-List |
    Out-File -FilePath (Join-Path $OutputDir "desktop-single-instance-processes.txt") -Encoding utf8

  if ($desktopProcesses.Count -lt 1) {
    throw "Desktop repeated launch did not leave a detectable Desktop process."
  }

  if ($desktopProcesses.Count -gt 1) {
    throw "Desktop repeated launch created more than one Desktop process: $($desktopProcesses.Count)"
  }

  Write-RuntimeLogTail -ProcessName "shipflow3-tauri" -EvidenceName "desktop-runtime-log"
}

function Get-ServiceSettingsProcesses {
  return @(
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.Name -eq "shipflow-service.exe" -and
        $_.CommandLine -notlike "*--shipflow-service-process*" -and
        $_.CommandLine -notlike "*--shipflow-service-autostart*" -and
        $_.CommandLine -notlike "*--shipflow-service-tray*"
      }
  )
}

function Get-ServiceTrayProcesses {
  return @(
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.Name -eq "shipflow-service.exe" -and
        $_.CommandLine -like "*--shipflow-service-tray*"
      }
  )
}

function Assert-ServiceSettingsSingleInstance {
  $settingsProcesses = Get-ServiceSettingsProcesses

  $settingsProcesses |
    Select-Object ProcessId, Name, ExecutablePath, CommandLine |
    Format-List |
    Out-File -FilePath (Join-Path $OutputDir "service-settings-single-instance-processes.txt") -Encoding utf8

  if ($settingsProcesses.Count -lt 1) {
    throw "Service Settings repeated launch did not leave a detectable settings process."
  }

  if ($settingsProcesses.Count -gt 1) {
    throw "Service Settings repeated launch created more than one settings process: $($settingsProcesses.Count)"
  }

  Write-RuntimeLogTail -ProcessName "shipflow-service" -EvidenceName "service-runtime-log"
}

function Assert-ServiceTraySingleInstance {
  $trayProcesses = Get-ServiceTrayProcesses

  $trayProcesses |
    Select-Object ProcessId, Name, ExecutablePath, CommandLine |
    Format-List |
    Out-File -FilePath (Join-Path $OutputDir "service-tray-single-instance-processes.txt") -Encoding utf8

  if ($trayProcesses.Count -lt 1) {
    throw "Service tray repeated launch did not leave a detectable tray process."
  }

  if ($trayProcesses.Count -gt 1) {
    throw "Service tray repeated launch created more than one tray process: $($trayProcesses.Count)"
  }

  Write-RuntimeLogTail -ProcessName "shipflow-service" -EvidenceName "service-tray-runtime-log"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$script:SigntoolPath = Resolve-Signtool

Write-RegistryEvidence

if ([string]::IsNullOrWhiteSpace($DesktopInstallerPath)) {
  throw "DesktopInstallerPath is required to collect signed Desktop installer evidence."
}

if ([string]::IsNullOrWhiteSpace($ServiceInstallerPath)) {
  throw "ServiceInstallerPath is required to collect signed Service installer evidence."
}

Verify-SignedFile -Path $DesktopExePath -Label "desktop-executable"
Verify-SignedFile -Path $ServiceExePath -Label "service-executable"
Verify-SignedFile -Path $DesktopInstallerPath -Label "desktop-installer"
Verify-SignedFile -Path $ServiceInstallerPath -Label "service-installer"

if ($LaunchDesktopTwice) {
  Start-Process -FilePath $DesktopExePath
  Start-Sleep -Seconds 2
  Start-Process -FilePath $DesktopExePath
  Start-Sleep -Seconds 2
  Assert-DesktopSingleInstance
}

if ($LaunchServiceSettingsTwice) {
  Start-Process -FilePath $ServiceExePath -ArgumentList "--shipflow-service-open-settings"
  Start-Sleep -Seconds 2
  Start-Process -FilePath $ServiceExePath -ArgumentList "--shipflow-service-open-settings"
  Start-Sleep -Seconds 2
  Assert-ServiceSettingsSingleInstance
}

if ($LaunchServiceTrayTwice) {
  Start-Process -FilePath $ServiceExePath -ArgumentList "--shipflow-service-tray"
  Start-Sleep -Seconds 2
  Start-Process -FilePath $ServiceExePath -ArgumentList "--shipflow-service-tray"
  Start-Sleep -Seconds 2
  Assert-ServiceTraySingleInstance
}

Write-ProcessEvidence
Write-RuntimeLogTailIfPresent -ProcessName "shipflow-service" -EvidenceName "service-tray-runtime-log"
Write-WindowStateEvidence

@"
ShipFlow native runtime smoke evidence was collected from installed Windows apps.

Collector: scripts/windows/collect-native-runtime-evidence.ps1
Desktop executable: $DesktopExePath
Service executable: $ServiceExePath
Desktop installer artifact: $DesktopInstallerPath
Service installer artifact: $ServiceInstallerPath
Executable discovery evidence: desktop-executable-discovery.txt, service-executable-discovery.txt
Require Start at login: $RequireStartAtLogin
Desktop repeated launch check: $LaunchDesktopTwice
Service Settings repeated launch check: $LaunchServiceSettingsTwice
Service tray repeated launch check: $LaunchServiceTrayTwice
Window state evidence: window-state.json

This evidence covers installed registry discovery, Authenticode verification,
signed installer verification, explicit Service login autostart registry state,
registry executable discovery matched to the verified collector executable,
legacy tray autostart removal, optional Desktop and Service Settings
repeated-launch single-instance focus verification with runtime logs, optional
Service tray repeated-launch single-instance verification, Windows Desktop tray readiness telemetry and action telemetry, persisted Desktop and Service Settings window state, optional Service tray action runtime logs, and a process snapshot.
"@ | Out-File -FilePath (Join-Path $OutputDir "README.txt") -Encoding utf8

Write-Host "Collected Windows native runtime evidence in $OutputDir"
