param(
  [string]$Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"

function Get-LibduckdbSysVersion {
  $lockLines = Get-Content "Cargo.lock"
  for ($index = 0; $index -lt $lockLines.Count; $index++) {
    if ($lockLines[$index] -eq 'name = "libduckdb-sys"') {
      for ($versionIndex = $index + 1; $versionIndex -lt [Math]::Min($index + 8, $lockLines.Count); $versionIndex++) {
        if ($lockLines[$versionIndex] -match '^version = "([^"]+)"$') {
          return $Matches[1]
        }
      }
    }
  }

  throw "Unable to find libduckdb-sys version in Cargo.lock."
}

function ConvertTo-DuckDbVersion {
  param([string]$CrateVersion)

  $parts = $CrateVersion.Split(".")
  if ($parts.Count -lt 3) {
    throw "Unexpected libduckdb-sys version format: $CrateVersion"
  }

  $encoded = [int]$parts[1]
  $major = [Math]::Floor($encoded / 10000)
  $minor = [Math]::Floor(($encoded / 100) % 100)
  $patch = $encoded % 100
  return "$major.$minor.$patch"
}

function Resolve-VCTool {
  param([string]$ToolName)

  $pathCommand = Get-Command $ToolName -ErrorAction SilentlyContinue
  if ($null -ne $pathCommand) {
    return $pathCommand.Source
  }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    throw "Unable to find vswhere.exe to locate $ToolName."
  }

  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ([string]::IsNullOrWhiteSpace($installPath)) {
    throw "Unable to find a Visual Studio installation with VC tools."
  }

  $tool = Get-ChildItem -Path (Join-Path $installPath "VC\Tools\MSVC") -Recurse -File -Filter $ToolName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*\bin\Hostx64\x64\$ToolName" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($null -eq $tool) {
    throw "Unable to find $ToolName in Visual Studio VC tools."
  }

  return $tool.FullName
}

function Write-DuckDbImportLibrary {
  param(
    [string]$DllPath,
    [string]$LibPath,
    [string]$Machine
  )

  $dumpbin = Resolve-VCTool "dumpbin.exe"
  $lib = Resolve-VCTool "lib.exe"
  $defPath = Join-Path (Split-Path -Parent $DllPath) "duckdb.def"

  $exports = & $dumpbin /nologo /exports $DllPath |
    ForEach-Object {
      if ($_ -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)$') {
        $Matches[1]
      }
    } |
    Where-Object { $_ -eq "duckdb" -or $_ -like "duckdb_*" } |
    Sort-Object -Unique

  if ($exports.Count -eq 0) {
    throw "Unable to extract DuckDB exports from $DllPath."
  }

  $defLines = @("LIBRARY duckdb.dll", "EXPORTS") + ($exports | ForEach-Object { "  $_" })
  Set-Content -Path $defPath -Value $defLines -Encoding ASCII

  & $lib /nologo "/def:$defPath" "/machine:$Machine" "/out:$LibPath"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $LibPath)) {
    throw "Failed to generate DuckDB import library at $LibPath."
  }
}

$crateVersion = Get-LibduckdbSysVersion
$duckDbVersion = ConvertTo-DuckDbVersion $crateVersion

switch ($Target) {
  "x86_64-pc-windows-msvc" {
    $archiveName = "libduckdb-windows-amd64.zip"
    $machine = "x64"
  }
  "aarch64-pc-windows-msvc" {
    $archiveName = "libduckdb-windows-arm64.zip"
    $machine = "arm64"
  }
  default {
    throw "Unsupported Windows DuckDB target: $Target"
  }
}

$targetRoot = Join-Path (Get-Location) "target"
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
$targetRoot = (Resolve-Path $targetRoot).Path
$downloadDir = Join-Path $targetRoot "duckdb-download\$Target\$duckDbVersion"
$archivePath = Join-Path $downloadDir $archiveName
$dllPath = Join-Path $downloadDir "duckdb.dll"
$headerPath = Join-Path $downloadDir "duckdb.h"
$libPath = Join-Path $downloadDir "duckdb.lib"

New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null

if (-not (Test-Path $dllPath) -or -not (Test-Path $headerPath)) {
  $url = "https://github.com/duckdb/duckdb/releases/download/v$duckDbVersion/$archiveName"
  Write-Host "Downloading DuckDB $duckDbVersion for $Target from $url"
  Invoke-WebRequest -Uri $url -OutFile $archivePath
  Expand-Archive -Path $archivePath -DestinationPath $downloadDir -Force
}

if (-not (Test-Path $dllPath)) {
  throw "Missing DuckDB runtime DLL at $dllPath."
}
if (-not (Test-Path $headerPath)) {
  throw "Missing DuckDB header at $headerPath."
}

if (-not (Test-Path $libPath)) {
  Write-Host "Generating DuckDB MSVC import library at $libPath"
  Write-DuckDbImportLibrary -DllPath $dllPath -LibPath $libPath -Machine $machine
}

Write-Host "Prepared DuckDB SDK at $downloadDir"
