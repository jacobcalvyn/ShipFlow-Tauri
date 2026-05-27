$ErrorActionPreference = "Stop"

function Resolve-Makensis {
  $candidates = @()
  $command = Get-Command makensis -ErrorAction SilentlyContinue

  if ($command) {
    $candidates += $command.Source
  }

  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} "NSIS\Bin\makensis.exe"
    $candidates += Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe"
  }

  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles "NSIS\Bin\makensis.exe"
    $candidates += Join-Path $env:ProgramFiles "NSIS\makensis.exe"
  }

  if ($env:ChocolateyInstall) {
    $candidates += Join-Path $env:ChocolateyInstall "bin\makensis.exe"
  }

  $candidates += "C:\ProgramData\chocolatey\bin\makensis.exe"

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "NSIS makensis.exe was not found. Install NSIS before building the Windows installer."
}
