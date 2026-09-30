using System;
using System.IO;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    /// <summary>Diagnostic: MAPLE_DUMP_FRAME=&lt;path.png&gt; writes the next
    /// CPU-rendered frame to disk — pixel-exact app output for the color
    /// parity harness, independent of screenshots/DWM.</summary>
    private static void DumpFrameIfRequested(byte[] bgra, int width, int height)
    {
        var path = Environment.GetEnvironmentVariable("MAPLE_DUMP_FRAME");
        if (string.IsNullOrEmpty(path) || File.Exists(path))
            return;
        try
        {
            using var bitmap = new System.Drawing.Bitmap(
                width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            var data = bitmap.LockBits(
                new System.Drawing.Rectangle(0, 0, width, height),
                System.Drawing.Imaging.ImageLockMode.WriteOnly,
                System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            System.Runtime.InteropServices.Marshal.Copy(bgra, 0, data.Scan0, bgra.Length);
            bitmap.UnlockBits(data);
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            DiagLog.Write($"[dump] frame {width}x{height} -> {path}");
        }
        catch (Exception ex)
        {
            DiagLog.Write($"[dump] failed: {ex.Message}");
        }
    }

}
