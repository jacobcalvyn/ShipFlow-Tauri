param(
  [Parameter(Mandatory = $true)]
  [string] $ArtifactPath,

  [Parameter(Mandatory = $true)]
  [string] $CertificateBase64,

  [Parameter(Mandatory = $true)]
  [string] $CertificatePassword
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ArtifactPath)) {
  throw "Artifact does not exist: $ArtifactPath"
}

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

$tempRoot = $env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($tempRoot)) {
  $tempRoot = [System.IO.Path]::GetTempPath()
}

$certificatePath = Join-Path $tempRoot "shipflow-code-signing.pfx"
[System.IO.File]::WriteAllBytes(
  $certificatePath,
  [System.Convert]::FromBase64String($CertificateBase64)
)

try {
  & $signtool.FullName sign `
    /f $certificatePath `
    /p $CertificatePassword `
    /fd SHA256 `
    /tr "http://timestamp.digicert.com" `
    /td SHA256 `
    $ArtifactPath

  & $signtool.FullName verify /pa /v $ArtifactPath
} finally {
  Remove-Item -Force $certificatePath -ErrorAction SilentlyContinue
}
