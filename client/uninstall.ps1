#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the Nurofen client, its helper service, tunnel and shortcuts.
  Pass -KeepProfile to keep the saved identity in %APPDATA%.
#>
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Nurofen",
  [switch]$KeepProfile,
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------- tunnel
Write-Host '[nurofen] снимаю туннель' -ForegroundColor Green
$awg = @(
  "$env:ProgramFiles\AmneziaWG\amneziawg.exe",
  "$env:ProgramFiles\AmneziaWG\wireguard.exe",
  "${env:ProgramFiles(x86)}\AmneziaWG\amneziawg.exe",
  "${env:ProgramFiles(x86)}\AmneziaWG\wireguard.exe",
  "$env:ProgramFiles\WireGuard\wireguard.exe",
  "${env:ProgramFiles(x86)}\WireGuard\wireguard.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($awg) {
  & $awg /uninstalltunnelservice nurofen 2>$null | Out-Null
  Start-Sleep -Seconds 1
}

# ---------------------------------------------------------- service
Write-Host '[nurofen] останавливаю и удаляю службу-помощник' -ForegroundColor Green
# Stop the scheduled task (new mechanism).
Stop-ScheduledTask -TaskName 'NurofenHelper' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'NurofenHelper' -Confirm:$false -ErrorAction SilentlyContinue
# Also clean up legacy Windows Service if it exists from an older install.
& sc.exe stop NurofenHelper 2>$null | Out-Null
Start-Sleep -Seconds 1
& sc.exe delete NurofenHelper 2>$null | Out-Null

# ---------------------------------------------------------- shortcuts
Write-Host '[nurofen] удаляю ярлыки' -ForegroundColor Green
$shortcuts = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nurofen.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Nurofen.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nurofen.lnk'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Nurofen.lnk'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup\Nurofen.lnk'),
  (Join-Path $env:PUBLIC 'Desktop\Nurofen.lnk')
)
foreach ($path in $shortcuts) { Remove-Item $path -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------- processes
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$InstallDir*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------- files
Write-Host '[nurofen] удаляю файлы' -ForegroundColor Green
if ($KeepFiles) {
  # The .exe uninstaller owns the program files; drop only what setup created.
  foreach ($item in @('Nurofen.vbs', 'NurofenBackground.vbs', 'defaults.json', 'setup.log')) {
    Remove-Item (Join-Path $InstallDir $item) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item (Join-Path $InstallDir 'runtime') -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $env:ProgramData 'Nurofen') -Recurse -Force -ErrorAction SilentlyContinue
if (-not $KeepProfile) {
  Remove-Item (Join-Path $env:APPDATA 'Nurofen') -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '[nurofen] готово' -ForegroundColor Green
