# Lists visible top-level windows (rect + size + class) for every running
# "Whale Companion" process, so probe measurements can be interpreted against
# the pet's actual on-screen geometry (avatar-only vs compact panel vs expanded).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gpu-probe-window-enum.ps1
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  struct RECT { public int L; public int T; public int R; public int B; }
  public static List<string> ByPid(uint target) {
    var outp = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        var cn = new StringBuilder(64); GetClassNameW(h, cn, 64);
        var tt = new StringBuilder(128); GetWindowTextW(h, tt, 128);
        outp.Add(string.Format("pid={0} rect=({1},{2})-({3},{4}) size={5}x{6} class={7} title={8}",
          p, r.L, r.T, r.R, r.B, r.R - r.L, r.B - r.T, cn.ToString(), tt.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*Whale Companion*' })
Write-Output ("whale process count: " + $procs.Count)
foreach ($proc in $procs) {
  foreach ($line in [WinEnum]::ByPid([uint32]$proc.ProcessId)) { Write-Output $line }
}
