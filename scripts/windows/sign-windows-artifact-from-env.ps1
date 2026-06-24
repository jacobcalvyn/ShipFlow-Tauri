param(
  [Parameter(Mandatory = $true)]
  [string] $ArtifactPath
)

$ErrorActionPreference = "Stop"

$certificateBase64 = $env:WINDOWS_CERTIFICATE
$certificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD

if ([string]::IsNullOrWhiteSpace($certificateBase64)) {
  throw "WINDOWS_CERTIFICATE is required to sign Windows updater artifacts."
}

if ([string]::IsNullOrWhiteSpace($certificatePassword)) {
  throw "WINDOWS_CERTIFICATE_PASSWORD is required to sign Windows updater artifacts."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$signScript = Join-Path $scriptDir "sign-windows-artifact.ps1"

& $signScript `
  -ArtifactPath $ArtifactPath `
  -CertificateBase64 $certificateBase64 `
  -CertificatePassword $certificatePassword
