# Hides the background Edge's window from the Windows taskbar (WS_EX_TOOLWINDOW) without
# hiding the window itself, so the page stays "visible" and keeps rendering.
#   taskbar.ps1 -ProfileDir <edge user-data-dir> [-Restore]
# Prints one line per top-level Edge window it touched.
param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [switch]$Restore
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AmzTaskbar {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static List<IntPtr> Find(HashSet<uint> pids) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
        var sb = new StringBuilder(64); GetClassName(h, sb, 64);
        if (sb.ToString() == "Chrome_WidgetWin_1") r.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

$needle = "--user-data-dir=$ProfileDir"
$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) -and -not $_.CommandLine.Contains('--type=') }
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($pr in $procs) { [void]$pids.Add([uint32]$pr.ProcessId) }
if ($pids.Count -eq 0) { Write-Output 'no-edge'; exit 0 }

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$SW_HIDE = 0
$SW_SHOWNA = 8

$windows = [AmzTaskbar]::Find($pids)
if ($windows.Count -eq 0) { Write-Output 'no-window'; exit 0 }
foreach ($h in $windows) {
  $ex = [AmzTaskbar]::GetWindowLongPtr($h, $GWL_EXSTYLE).ToInt64()
  if ($Restore) { $new = ($ex -band (-bnot $WS_EX_TOOLWINDOW)) -bor $WS_EX_APPWINDOW }
  else          { $new = ($ex -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW) }
  if ($new -eq $ex) { Write-Output "unchanged $h"; continue }
  # The taskbar only re-evaluates the style across a hide/show cycle.
  [void][AmzTaskbar]::ShowWindow($h, $SW_HIDE)
  [void][AmzTaskbar]::SetWindowLongPtr($h, $GWL_EXSTYLE, [IntPtr]$new)
  [void][AmzTaskbar]::ShowWindow($h, $SW_SHOWNA)
  Write-Output "changed $h"
}
