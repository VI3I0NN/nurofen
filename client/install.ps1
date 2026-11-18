#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the Nurofen Windows client: portable Node runtime, AmneziaWG,
  the privileged helper service and a Start Menu shortcut.

.EXAMPLE
  .\install.ps1 -Server http://203.0.113.10:8787
#>
param(
  [string]$Server = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\Nurofen",
  [switch]$NoAutostart,
  [switch]$SkipAwg
)

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $InstallDir 'app'
$RuntimeDir = Join-Path $InstallDir 'runtime'
$DataDir = Join-Path $env:ProgramData 'Nurofen'
$NodeExe = $null

function Write-Step($message) { Write-Host "[nurofen] $message" -ForegroundColor Green }
function Write-Warn($message) { Write-Host "[nurofen] $message" -ForegroundColor Yellow }

# ------------------------------------------------------------------ copy app
Write-Step "устанавливаю файлы в $InstallDir"
New-Item -ItemType Directory -Force -Path $AppDir, $RuntimeDir, $DataDir | Out-Null
Remove-Item (Join-Path $AppDir 'src') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $PSScriptRoot 'src') -Destination $AppDir -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot 'package.json') -Destination $AppDir -Force
$assets = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
if (Test-Path $assets) {
  Copy-Item $assets -Destination $AppDir -Recurse -Force
}

# ---------------------------------------------------------------------- node
$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode) {
  $version = (& node --version) -replace 'v', ''
  if ([int]($version.Split('.')[0]) -ge 22) {
    $NodeExe = $systemNode.Source
    Write-Step "использую системный node $version"
  }
}
if (-not $NodeExe) {
  $portable = Join-Path $RuntimeDir 'node.exe'
  if (Test-Path $portable) {
    $NodeExe = $portable
    Write-Step 'использую уже скачанный node'
  } else {
    Write-Step 'скачиваю переносимый Node.js 22'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $release = $index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
    if (-not $release) { throw 'не удалось найти Node.js 22 в индексе nodejs.org' }
    $file = "node-$($release.version)-win-x64.zip"
    $url = "https://nodejs.org/dist/$($release.version)/$file"
    $zip = Join-Path $env:TEMP $file
    Invoke-WebRequest $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
    Expand-Archive $zip -DestinationPath $RuntimeDir -Force
    Copy-Item (Join-Path $RuntimeDir "node-$($release.version)-win-x64\node.exe") $portable -Force
    Remove-Item (Join-Path $RuntimeDir "node-$($release.version)-win-x64") -Recurse -Force
    Remove-Item $zip -Force
    $NodeExe = $portable
  }
}

# -------------------------------------------------------------------- amnezia
$awgPaths = @(
  "$env:ProgramFiles\AmneziaWG\amneziawg.exe",
  "$env:ProgramFiles\AmneziaWG\wireguard.exe",
  "${env:ProgramFiles(x86)}\AmneziaWG\amneziawg.exe"
)
$awgFound = $awgPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $awgFound -and -not $SkipAwg) {
  Write-Step 'устанавливаю AmneziaWG (официальный клиент)'
  $msi = Join-Path $env:TEMP 'amneziawg-amd64.msi'
  Invoke-WebRequest 'https://github.com/amnezia-vpn/amneziawg-windows-client/releases/download/3.1.0/amneziawg-amd64-3.1.0.msi' -OutFile $msi -UseBasicParsing -TimeoutSec 300
  $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
  if ($proc.ExitCode -ne 0) { Write-Warn "msiexec вернул код $($proc.ExitCode), проверьте установку AmneziaWG вручную" }
  Start-Sleep -Seconds 2
  $awgFound = $awgPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($awgFound) { Write-Step "AmneziaWG: $awgFound" } else { Write-Warn 'AmneziaWG не найден — туннель не поднимется, пока не установите его' }

# ------------------------------------------------------------- helper service
Write-Step 'настраиваю службу-помощник'
$tokenFile = Join-Path $DataDir 'helper-token'
if (-not (Test-Path $tokenFile)) {
  $token = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
  Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
}
& icacls.exe $DataDir /grant '*S-1-5-32-545:(OI)(CI)(RX)' | Out-Null
& icacls.exe $tokenFile /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' '*S-1-5-32-545:(R)' | Out-Null

$binPath = "`"$NodeExe`" `"$(Join-Path $AppDir 'src\main.js')`" --helper"
if (Get-Service NurofenHelper -ErrorAction SilentlyContinue) {
  Stop-Service NurofenHelper -Force -ErrorAction SilentlyContinue
  & sc.exe delete NurofenHelper | Out-Null
  Start-Sleep -Seconds 1
}
# New-Service takes the binary path verbatim, so quoting stays correct.
New-Service -Name NurofenHelper -BinaryPathName $binPath -StartupType Automatic -DisplayName 'Nurofen Helper' | Out-Null
& sc.exe description NurofenHelper 'Поднимает и опускает туннель Nurofen по запросу локального клиента.' | Out-Null
& sc.exe failure NurofenHelper reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
Start-Service NurofenHelper
Start-Sleep -Seconds 1
$helperState = (Get-Service NurofenHelper -ErrorAction SilentlyContinue).Status -eq 'Running'
if ($helperState) { Write-Step 'служба-помощник запущена' } else { Write-Warn 'служба-помощник не запустилась, смотрите журнал в C:\ProgramData\Nurofen\helper.log' }

# ------------------------------------------------------------- default server
if ($Server) {
  $defaults = @{ serverUrl = $Server } | ConvertTo-Json
  Set-Content -Path (Join-Path $AppDir 'defaults.json') -Value $defaults -Encoding utf8
  Write-Step "адрес сервера по умолчанию: $Server"
}

# ----------------------------------------------------------------- shortcuts
Write-Step 'создаю ярлыки'
$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $AppDir 'assets\nurofen.ico'
function New-NurofenShortcut([string]$path, [string]$arguments) {
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $NodeExe
  $shortcut.Arguments = "`"$(Join-Path $AppDir 'src\main.js')`" $arguments"
  $shortcut.WorkingDirectory = $AppDir
  $shortcut.IconLocation = $icon
  $shortcut.Description = 'Nurofen — виртуальная локальная сеть'
  $shortcut.Save()
}
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nurofen.lnk'
New-NurofenShortcut $startMenu ''
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nurofen.lnk'
New-NurofenShortcut $desktop ''
if (-not $NoAutostart) {
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Nurofen.lnk'
  New-NurofenShortcut $startup '--no-window'
}

# ------------------------------------------------------------------- launch
Write-Step 'запускаю клиент'
Start-Process explorer.exe -ArgumentList "`"$desktop`""

Write-Host ''
Write-Host '  Готово. Клиент запущен.' -ForegroundColor Green
Write-Host '  Код приглашения вводится в окне Nurofen (его даёт создатель сети).'
Write-Host "  Журнал клиента: $env:APPDATA\Nurofen\client.log"
Write-Host "  Журнал службы:  $DataDir\helper.log"
Write-Host ''
