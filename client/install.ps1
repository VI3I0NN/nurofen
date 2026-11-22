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
  [switch]$NoCopy,
  [switch]$NoLaunch,
  [switch]$NoAutostart,
  [switch]$NoShortcuts,
  [switch]$SkipAwg
)

$ErrorActionPreference = 'Stop'
$AppDir = $InstallDir
$RuntimeDir = Join-Path $InstallDir 'runtime'
$DataDir = Join-Path $env:ProgramData 'Nurofen'
$NodeExe = $null

function Write-Step($message) { Write-Host "[nurofen] $message" -ForegroundColor Green }
function Write-Warn($message) { Write-Host "[nurofen] $message" -ForegroundColor Yellow }

# Several origins per file: the project's own server first (reachable where
# GitHub and nodejs.org are slow or filtered), official releases second.
function Get-File([string[]]$urls, [string]$out) {
  foreach ($url in $urls) {
    if (-not $url) { continue }
    try {
      Write-Step "качаю $url"
      Invoke-WebRequest $url -OutFile $out -UseBasicParsing -TimeoutSec 600
      if ((Get-Item $out).Length -gt 0) { return $true }
    } catch {
      Write-Warn "не вышло: $($_.Exception.Message)"
    }
  }
  return $false
}

# --------------------------------------------------------------- stop old app
# A running client keeps port 39391 and keeps the old code in memory, so stop it
# before replacing files. This also catches a copy started elevated earlier.
$stopped = 0
$oldClients = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" }
foreach ($proc in $oldClients) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $stopped++
}
$oldShells = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" }
foreach ($proc in $oldShells) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $stopped++
}
$oldTrays = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*tray.ps1*' }
foreach ($proc in $oldTrays) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $stopped++
}
if ($stopped -gt 0) {
  Write-Step 'остановил запущенный клиент'
  Start-Sleep -Milliseconds 700
}

# ------------------------------------------------------------------ copy app
if ($NoCopy) {
  Write-Step "файлы уже на месте: $AppDir"
  if (-not (Test-Path (Join-Path $AppDir 'src\main.js'))) { throw "в $AppDir нет src\main.js" }
  New-Item -ItemType Directory -Force -Path $RuntimeDir, $DataDir | Out-Null
} else {
  Write-Step "устанавливаю файлы в $InstallDir"
  New-Item -ItemType Directory -Force -Path $AppDir, $RuntimeDir, $DataDir | Out-Null
  Remove-Item (Join-Path $AppDir 'src') -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $PSScriptRoot 'src') -Destination $AppDir -Recurse -Force
  Copy-Item (Join-Path $PSScriptRoot 'package.json') -Destination $AppDir -Force
  $electronAppSrc = Join-Path $PSScriptRoot 'electron'
  if (Test-Path $electronAppSrc) {
    Remove-Item (Join-Path $AppDir 'electron-app') -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $electronAppSrc -Destination (Join-Path $AppDir 'electron-app') -Recurse -Force
  }
  $assets = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
  if (Test-Path $assets) {
    Copy-Item $assets -Destination $AppDir -Recurse -Force
  }
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
    $zip = Join-Path $env:TEMP 'nurofen-node.zip'
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $base = $Server.TrimEnd('/')
    $done = $false
    if ($base) { $done = Get-File @("$base/dl/node.zip") $zip }
    if (-not $done) {
      Write-Step 'ищу Node.js 22 на nodejs.org'
      $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 30
      $release = $index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
      if (-not $release) { throw 'не удалось найти Node.js 22 в индексе nodejs.org' }
      $done = Get-File @("https://nodejs.org/dist/$($release.version)/node-$($release.version)-win-x64.zip") $zip
    }
    if (-not $done) { throw 'не удалось скачать Node.js: проверьте интернет и повторите установку' }

    $unpack = Join-Path $RuntimeDir 'unpack'
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip -DestinationPath $unpack -Force
    $found = Get-ChildItem $unpack -Recurse -Filter node.exe | Select-Object -First 1
    if (-not $found) { throw 'в скачанном архиве нет node.exe' }
    Copy-Item $found.FullName $portable -Force
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $NodeExe = $portable
  }
}

# -------------------------------------------------------------------- amnezia
# install.ps1 may run under 32-bit PowerShell (Inno Setup calls it that way), so
# $env:ProgramFiles points at "Program Files (x86)". Ask ProgramW6432 for the
# real 64-bit location and keep both variants.
$pf64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$pf32 = ${env:ProgramFiles(x86)}
$awgPaths = @(
  "$pf64\AmneziaWG\amneziawg.exe",
  "$pf64\AmneziaWG\wireguard.exe",
  "$pf64\WireGuard\wireguard.exe",
  "$pf32\AmneziaWG\amneziawg.exe",
  "$pf32\AmneziaWG\wireguard.exe",
  "$pf32\WireGuard\wireguard.exe"
) | Select-Object -Unique
$awgFound = $awgPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $awgFound -and -not $SkipAwg) {
  Write-Step 'устанавливаю AmneziaWG (официальный клиент)'
  $msi = Join-Path $env:TEMP 'amneziawg-amd64.msi'
  $base = $Server.TrimEnd('/')
  $urls = @()
  if ($base) { $urls += "$base/dl/amneziawg.msi" }
  $urls += 'https://github.com/amnezia-vpn/amneziawg-windows-client/releases/download/3.1.0/amneziawg-amd64-3.1.0.msi'
  if (-not (Get-File $urls $msi)) { throw 'не удалось скачать AmneziaWG' }
  $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
  if ($proc.ExitCode -ne 0) { Write-Warn "msiexec вернул код $($proc.ExitCode), проверьте установку AmneziaWG вручную" }
  for ($i = 0; $i -lt 15; $i++) {
    $awgFound = $awgPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($awgFound) { break }
    Start-Sleep -Seconds 1
  }
}
if ($awgFound) { Write-Step "AmneziaWG: $awgFound" } else { Write-Warn 'AmneziaWG не найден — туннель не поднимется, пока не установите его' }

# ------------------------------------------------------------- firewall
# Windows blocks inbound ICMP and unsolicited LAN traffic by default, so peers
# cannot ping each other or host a game. Open only the virtual LAN range.
Write-Step 'разрешаю трафик виртуальной сети в брандмауэре'
$lanRules = @(
  @{ Name = 'Nurofen-LAN-ICMP'; Protocol = 'icmpv4:8,any' },
  @{ Name = 'Nurofen-LAN-TCP';  Protocol = 'TCP' },
  @{ Name = 'Nurofen-LAN-UDP';  Protocol = 'UDP' }
)
foreach ($rule in $lanRules) {
  & netsh.exe advfirewall firewall delete rule "name=$($rule.Name)" 2>$null | Out-Null
  & netsh.exe advfirewall firewall add rule "name=$($rule.Name)" dir=in action=allow "protocol=$($rule.Protocol)" remoteip=10.66.0.0/16 profile=any 2>$null | Out-Null
}

# ------------------------------------------------------------- helper service
Write-Step 'настраиваю службу-помощник'
$tokenFile = Join-Path $DataDir 'helper-token'
if (-not (Test-Path $tokenFile)) {
  $token = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
  Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
}
& icacls.exe $DataDir /grant '*S-1-5-32-545:(OI)(CI)(RX)' | Out-Null
& icacls.exe $tokenFile /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' '*S-1-5-32-545:(R)' | Out-Null

# Remove legacy Windows Service (node.exe cannot act as a proper SCM service).
if (Get-Service NurofenHelper -ErrorAction SilentlyContinue) {
  Stop-Service NurofenHelper -Force -ErrorAction SilentlyContinue
  & sc.exe delete NurofenHelper 2>$null | Out-Null
  Start-Sleep -Seconds 1
}

# Use a Scheduled Task running as SYSTEM at startup — it doesn't require the
# SCM protocol that node.exe cannot provide.
$taskName = 'NurofenHelper'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action  = New-ScheduledTaskAction -Execute $NodeExe `
           -Argument "`"$(Join-Path $AppDir 'src\main.js')`" --helper" `
           -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -StartWhenAvailable

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
} catch {
  Write-Warn "Register-ScheduledTask: $($_.Exception.Message), пробую schtasks.exe"
  & schtasks.exe /create /tn $taskName /tr "`"$NodeExe`" `"`"$(Join-Path $AppDir 'src\main.js')`"`" --helper" /sc onstart /ru "SYSTEM" /rl HIGHEST /f 2>$null | Out-Null
}

Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
& schtasks.exe /run /tn $taskName 2>$null | Out-Null

$helperRunning = $false
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 600
  try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:39394/health' -TimeoutSec 1
    if ($resp.ok) {
      $helperRunning = $true
      break
    }
  } catch {}
}
if ($helperRunning) { Write-Step 'служба-помощник запущена' } else { Write-Warn 'служба-помощник не ответила на health-проверку (будет запущена при перезагрузке)' }

# ------------------------------------------------------------- default server
if ($Server) {
  $defaults = [ordered]@{ serverUrl = $Server }
  # Write UTF-8 without BOM: JSON.parse in Node rejects a leading BOM.
  $defaultsPath = Join-Path $AppDir 'defaults.json'
  [System.IO.File]::WriteAllText($defaultsPath, ($defaults | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "адрес общего сервера задан установщиком"
}

# ------------------------------------------------------------------- launch
# The desktop shell is electron.exe from the bundled runtime. The .vbs files are
# only a fallback for a manual install without Electron: node.exe is a console
# binary and a shortcut straight to it would open a black window.
$mainScript = Join-Path $AppDir 'src\main.js'
function New-Launcher([string]$path, [string]$extra) {
  $command = '"' + $NodeExe + '" "' + $mainScript + '"'
  if ($extra) { $command = "$command $extra" }
  $literal = '"' + $command.Replace('"', '""') + '"'
  # WSH reads UTF-16 .vbs reliably even when the path contains Cyrillic.
  Set-Content -Path $path -Encoding Unicode -Value @(
    'Set sh = CreateObject("WScript.Shell")'
    "sh.Run $literal, 0, False"
  )
}
$launcher = Join-Path $AppDir 'Nurofen.vbs'
$launcherHidden = Join-Path $AppDir 'NurofenBackground.vbs'
New-Launcher $launcher ''
New-Launcher $launcherHidden '--no-window'

$electronExe = Join-Path $AppDir 'electron\electron.exe'
$electronApp = Join-Path $AppDir 'electron-app'
$hasElectron = (Test-Path $electronExe) -and (Test-Path (Join-Path $electronApp 'main.js'))
if ($hasElectron) {
  Write-Step 'окно работает на встроенном Electron'
} else {
  Write-Warn 'Electron не найден — окно откроется в браузере по умолчанию'
}

# -------------------------------------------------------------------- legacy
# 0.2.x started through wscript + NurofenBackground.vbs. Once Electron is on
# disk those shortcuts must go, otherwise the old and the new client would both
# start at logon (and fight for port 39391).
if ($hasElectron) {
  $legacyShell = New-Object -ComObject WScript.Shell
  $legacyLinks = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Nurofen.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nurofen.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nurofen.lnk')
  )
  foreach ($path in $legacyLinks) {
    if (-not (Test-Path $path)) { continue }
    try {
      $old = $legacyShell.CreateShortcut($path)
      if ($old.TargetPath -like '*wscript.exe' -and $old.Arguments -like '*Nurofen*') {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
        Write-Step "убрал старый ярлык: $path"
      }
    } catch {
      # A broken .lnk is not worth failing the installation over.
    }
  }
}

# ----------------------------------------------------------------- shortcuts
if (-not $NoShortcuts) {
  Write-Step 'создаю ярлыки'
  $shell = New-Object -ComObject WScript.Shell
  $icon = Join-Path $AppDir 'assets\nurofen.ico'
  if (-not (Test-Path $icon)) { $icon = $electronExe }
  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  function New-NurofenShortcut([string]$path, [switch]$Hidden) {
    $shortcut = $shell.CreateShortcut($path)
    if ($hasElectron) {
      $shortcut.TargetPath = $electronExe
      $shortcut.Arguments = if ($Hidden) { "`"$electronApp`" --hidden" } else { "`"$electronApp`"" }
    } else {
      $shortcut.TargetPath = $wscript
      $shortcut.Arguments = "`"$(if ($Hidden) { $launcherHidden } else { $launcher })`""
    }
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.IconLocation = $icon
    $shortcut.Description = 'Nurofen — виртуальная локальная сеть'
    $shortcut.Save()
  }
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nurofen.lnk'
  New-NurofenShortcut $startMenu
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nurofen.lnk'
  New-NurofenShortcut $desktop
  if (-not $NoAutostart) {
    $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Nurofen.lnk'
    New-NurofenShortcut $startup -Hidden
  }
}

# ------------------------------------------------------------------- launch
if ($NoLaunch) {
  Write-Step 'готово, ярлык Nurofen на рабочем столе и в меню «Пуск»'
} else {
  Write-Step 'запускаю клиент'
  if ($hasElectron) {
    Start-Process $electronExe -ArgumentList "`"$electronApp`"" -WorkingDirectory $AppDir
  } else {
    Start-Process $wscript -ArgumentList "`"$launcher`""
  }
}

Write-Host ''
Write-Host '  Готово. Клиент запущен.' -ForegroundColor Green
Write-Host '  В окне Nurofen создайте сеть или подключитесь к существующей по названию и паролю.'
Write-Host "  Журнал клиента: $env:APPDATA\Nurofen\client.log"
Write-Host "  Журнал службы:  $DataDir\helper.log"
Write-Host ''
