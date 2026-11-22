<#
.SYNOPSIS
  Builds dist\NurofenSetup.exe — the client installer you give to friends.

.EXAMPLE
  .\tools\build-installer.ps1
  .\tools\build-installer.ps1 -Server http://1.2.3.4:8787

.NOTES
  Needs Inno Setup 6 or 7 (https://jrsoftware.org/isdl.php). ISCC.exe is looked
  up on PATH, in Program Files and in %LOCALAPPDATA%\Programs\Inno.
#>
param(
  [string]$Server = 'http://201.58.187.214:8787',
  [string]$Output = '',
  [string]$Notes = 'Выровнена карточка подключения, окно стало уже и больше не изменяет размер.'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

# Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so Cyrillic text breaks
# on systems with a non-UTF-8 code page. Keep every shipped script UTF-8 + BOM.
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
foreach ($rel in @(
  'client\install.ps1', 'client\uninstall.ps1', 'client\src\tray.ps1', 'client\src\focus.ps1',
  'tools\installer.iss', 'tools\installer-notes.txt'
)) {
  $path = Join-Path $repo $rel
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if (-not $hasBom) {
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($path, $text, $utf8Bom)
    Write-Host "[build] добавил UTF-8 BOM: $rel" -ForegroundColor Yellow
  }
}

function Find-Iscc {
  $candidates = @(
    (Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    "$env:LOCALAPPDATA\Programs\Inno\ISCC.exe"
    "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe"
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw 'ISCC.exe не найден. Поставьте Inno Setup: winget install JRSoftware.InnoSetup.7'
}

$version = (Get-Content (Join-Path $repo 'client\package.json') -Raw | ConvertFrom-Json).version
if (-not $version) { $version = '0.1.0' }

# Electron is bundled into the installer so friends do not depend on their
# browser at all. The archive is cached in tools\cache and unpacked once.
$electronVersion = '45.4.1'
$electronZip = Join-Path $PSScriptRoot "cache\electron-v$electronVersion-win32-x64.zip"
$electronDir = Join-Path $PSScriptRoot "cache\electron-$electronVersion"
if (-not (Test-Path (Join-Path $electronDir 'electron.exe'))) {
  if (-not (Test-Path $electronZip)) {
    throw "Нет $electronZip. Скачайте electron-v$electronVersion-win32-x64.zip в tools\cache."
  }
  Write-Host "[build] распаковываю Electron $electronVersion…" -ForegroundColor Yellow
  Remove-Item $electronDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $electronDir | Out-Null
  Expand-Archive -LiteralPath $electronZip -DestinationPath $electronDir -Force
}
# Two UI languages are enough and it keeps the installer ~40 MB smaller.
$locales = Join-Path $electronDir 'locales'
if (Test-Path $locales) {
  Get-ChildItem $locales -File |
    Where-Object { $_.Name -notin @('ru.pak', 'en-US.pak') } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

$iscc = Find-Iscc
$outDir = if ($Output) { $Output } else { Join-Path $repo 'dist' }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$args = @(
  "/DServerUrl=$Server"
  "/DAppVersion=$version"
  "/DElectronDir=$electronDir"
  "/O$outDir"
  "/Qp"
  (Join-Path $PSScriptRoot 'installer.iss')
)

Write-Host "[build] server:     $Server"
Write-Host "[build] electron:   $electronDir"
Write-Host "[build] iscc:       $iscc"
& $iscc @args
if ($LASTEXITCODE -ne 0) { throw "iscc вернул код $LASTEXITCODE" }

$setup = Join-Path $outDir 'NurofenSetup.exe'
if (-not (Test-Path $setup)) { throw "установщик не появился: $setup" }
$size = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host "[build] готово: $setup ($size МБ)" -ForegroundColor Green

# --------------------------------------------------- client auto-update pack
# Only the code, no Electron runtime: the client replaces its own files and
# restarts. The installer stays the way to get Electron itself.
$packDir = Join-Path $PSScriptRoot 'cache\client-pack'
Write-Host '[build] собираю client.zip для автообновления…' -ForegroundColor Yellow
Remove-Item $packDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $packDir | Out-Null
Copy-Item (Join-Path $repo 'client\src') -Destination (Join-Path $packDir 'src') -Recurse -Force
Copy-Item (Join-Path $repo 'client\electron') -Destination (Join-Path $packDir 'electron-app') -Recurse -Force
Copy-Item (Join-Path $repo 'client\package.json') -Destination (Join-Path $packDir 'package.json') -Force
$assetsDir = Join-Path $repo 'assets'
if (Test-Path $assetsDir) {
  Copy-Item $assetsDir -Destination (Join-Path $packDir 'assets') -Recurse -Force
}

$clientZip = Join-Path $outDir 'client.zip'
Remove-Item $clientZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $packDir '*') -DestinationPath $clientZip -CompressionLevel Optimal -Force

$manifest = [ordered]@{
  version = $version
  file    = 'client.zip'
  sha256  = (Get-FileHash $clientZip -Algorithm SHA256).Hash.ToLower()
  size    = (Get-Item $clientZip).Length
  notes   = $Notes
}
$manifestPath = Join-Path $outDir 'client.json'
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
$zipSize = [math]::Round((Get-Item $clientZip).Length / 1KB, 1)
Write-Host "[build] client.zip: $clientZip ($zipSize КБ), версия $version" -ForegroundColor Green
