$ErrorActionPreference = "Stop"

function Resolve-TauriAppVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ConfigPath
  )

  $resolvedConfigPath = (Resolve-Path $ConfigPath).Path
  $config = Get-Content -Raw -Path $resolvedConfigPath | ConvertFrom-Json
  $version = [string] $config.version

  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Missing version in $resolvedConfigPath."
  }

  return $version.Trim()
}

function Convert-ToWindowsVersionQuad {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Version
  )

  $coreVersion = ($Version -split "[-+]")[0]
  $parts = $coreVersion.Split(".")
  if ($parts.Count -lt 1 -or $parts.Count -gt 4) {
    throw "Unable to convert app version '$Version' into a Windows version quad."
  }

  $numericParts = @()
  foreach ($part in $parts) {
    $number = 0
    if (-not [int]::TryParse($part, [ref] $number) -or $number -lt 0 -or $number -gt 65535) {
      throw "Invalid Windows version component '$part' in '$Version'."
    }

    $numericParts += $number
  }

  while ($numericParts.Count -lt 4) {
    $numericParts += 0
  }

  return ($numericParts -join ".")
}
