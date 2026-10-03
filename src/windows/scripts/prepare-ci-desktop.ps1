$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
    throw 'Desktop preparation is restricted to the disposable GitHub Actions runner.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LifecycleDesktop
{
    [StructLayout(LayoutKind.Explicit, Size = 220)]
    public struct DisplayMode
    {
        [FieldOffset(68)] public ushort Size;
        [FieldOffset(72)] public uint Fields;
        [FieldOffset(172)] public uint Width;
        [FieldOffset(176)] public uint Height;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettingsW(string device, int mode, ref DisplayMode settings);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int ChangeDisplaySettingsExW(string device, ref DisplayMode settings,
        IntPtr window, uint flags, IntPtr parameter);

    public static DisplayMode Current()
    {
        var mode = new DisplayMode { Size = 220 };
        if (!EnumDisplaySettingsW(null, -1, ref mode))
            throw new InvalidOperationException("Cannot read the runner's primary display mode.");
        return mode;
    }

    public static void Prepare()
    {
        var mode = Current();
        if (mode.Width >= 1920 && mode.Height >= 1080) return;
        mode.Width = 1920;
        mode.Height = 1080;
        mode.Fields = 0x00180000;
        var test = ChangeDisplaySettingsExW(null, ref mode, IntPtr.Zero, 2, IntPtr.Zero);
        if (test != 0)
            throw new InvalidOperationException($"Runner cannot support the required 1920x1080 desktop: {test}.");
        var applied = ChangeDisplaySettingsExW(null, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
        if (applied != 0)
            throw new InvalidOperationException($"Runner desktop change failed: {applied}.");
    }
}
'@

$before = [LifecycleDesktop]::Current()
[LifecycleDesktop]::Prepare()
$deadline = [Environment]::TickCount64 + 5000
do {
    Start-Sleep -Milliseconds 100
    $after = [LifecycleDesktop]::Current()
} while (($after.Width -lt 1920 -or $after.Height -lt 1080) -and
    [Environment]::TickCount64 -lt $deadline)

$root = Join-Path $env:RUNNER_TEMP 'maple-window-lifecycle'
New-Item -ItemType Directory -Force $root | Out-Null
@{
    before = @{ width = $before.Width; height = $before.Height }
    after = @{ width = $after.Width; height = $after.Height }
    required = @{ width = 1920; height = 1080 }
} | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $root 'desktop.json')
if ($after.Width -lt 1920 -or $after.Height -lt 1080) {
    throw "Runner desktop is only $($after.Width)x$($after.Height); layout qualification requires 1920x1080."
}
Write-Output "Lifecycle desktop ready: $($after.Width)x$($after.Height)"
