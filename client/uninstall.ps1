#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the Nurofen client, its helper service and shortcuts.
  Pass -KeepProfile to keep the saved identity in %APPDATA%.
#>
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Nurofen",
  [switch]$KeepProfile
)

$ErrorActionPreference = 'Continue'
Write-Host '[nurofen] останавливаю и удаляю службу-помощник' -ForegroundColor Green
& sc.exe stop NurofenHelper | Out-Null
Start-Sleep -Seconds 1
& sc.exe delete NurofenHelper | Out-Null

Write-Host '[nurofen] удаляю ярлыки' -ForegroundColor Green
$shortcuts = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nurofen.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Nurofen.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nurofen.lnk')
)
foreach ($path in $shortcuts) { Remove-Item $path -Force -ErrorAction SilentlyContinue }

Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$InstallDir*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host '[nurofen] удаляю файлы' -ForegroundColor Green
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:ProgramData 'Nurofen') -Recurse -Force -ErrorAction SilentlyContinue
if (-not $KeepProfile) {
  Remove-Item (Join-Path $env:APPDATA 'Nurofen') -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '[nurofen] готово' -ForegroundColor Green
