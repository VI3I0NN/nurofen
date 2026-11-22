# Brings the already open Nurofen window to the front.
# Prints "focused" when a window was found, "notfound" otherwise, so the
# caller can decide between focusing and opening a new window.

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NurofenWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$target = Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'Nurofen*' } |
  Select-Object -First 1

if (-not $target) {
  Write-Output 'notfound'
  exit 1
}

# 9 = SW_RESTORE: un-minimise if needed.
[NurofenWindow]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
[NurofenWindow]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
Write-Output 'focused'
