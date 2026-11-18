param(
  [int]$Port = 39391,
  [string]$Icon = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$notify = New-Object System.Windows.Forms.NotifyIcon
if ($Icon -and (Test-Path $Icon)) {
  try { $notify.Icon = New-Object System.Drawing.Icon($Icon) } catch { $notify.Icon = [System.Drawing.SystemIcons]::Shield }
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Shield
}
$notify.Text = 'Nurofen'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = 'проверяю…'
$statusItem.Enabled = $false
$menu.Items.Add($statusItem) | Out-Null
$menu.Items.Add('-') | Out-Null
$openItem = $menu.Items.Add('Открыть окно')
$toggleItem = $menu.Items.Add('Включить / выключить')
$menu.Items.Add('-') | Out-Null
$exitItem = $menu.Items.Add('Выход')

function Invoke-Api([string]$path, [string]$body = '{}') {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    return $false
  }
}

$openItem.add_Click({ Invoke-Api '/api/window' | Out-Null })
$toggleItem.add_Click({ Invoke-Api '/api/action' '{"name":"toggle"}' | Out-Null })
$exitItem.add_Click({
  Invoke-Api '/api/quit' | Out-Null
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$notify.add_DoubleClick({ Invoke-Api '/api/window' | Out-Null })
$notify.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 3
    $label = switch ($state.status) {
      'connected' { 'в сети' }
      'connecting' { 'подключение' }
      'error' { 'ошибка' }
      default { 'выключено' }
    }
    $text = "Nurofen — $label"
    if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
    $statusItem.Text = $label
    $notify.Text = $text
    if ($state.status -eq 'connected' -and $state.profile.self) {
      $toggleItem.Text = "Отключить ($($state.profile.self.ip))"
    } else {
      $toggleItem.Text = 'Включить'
    }
  } catch {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
