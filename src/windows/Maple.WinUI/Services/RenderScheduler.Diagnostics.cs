using System;
using System.IO;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    // #4329: diagnostic readback runs only in a separate parity process, with
    // the production session and all parameter arrays still pinned under _gate.
    private static unsafe void DumpGpuFrameIfRequested(
        Native.MapleGpuLiveSession* handle, Native.MapleGpuLiveParams* parameters,
        DecodedImage image)
    {
        var path = Environment.GetEnvironmentVariable("MAPLE_DUMP_GPU_FRAME");
        if (string.IsNullOrEmpty(path) || File.Exists(path)) return;
        var rgb = new byte[checked(image.Width * image.Height * 3)];
        fixed (byte* output = rgb)
        {
            var rc = Native.RawFfi.maple_gpu_live_render(handle, parameters, output);
            if (rc != 0)
                throw new InvalidOperationException($"GPU parity readback rc={rc}: {Native.RawFfi.LastError()}");
        }
        var bgra = new byte[checked(image.Width * image.Height * 4)];
        for (int source = 0, destination = 0; source < rgb.Length; source += 3, destination += 4)
        {
            bgra[destination] = rgb[source + 2];
            bgra[destination + 1] = rgb[source + 1];
            bgra[destination + 2] = rgb[source];
            bgra[destination + 3] = 255;
        }
        SaveFrame(bgra, image.Width, image.Height, path);
        DiagLog.Write($"[dump-gpu] develop-chain {image.Width}x{image.Height} -> {path}");
    }

    /// <summary>Diagnostic: MAPLE_DUMP_FRAME=&lt;path.png&gt; writes the next
    /// settled CPU-rendered frame to disk — pixel-exact app output for the color
    /// parity harness, independent of screenshots/DWM.</summary>
    private static void DumpFrameIfRequested(byte[] bgra, int width, int height)
    {
        var path = Environment.GetEnvironmentVariable("MAPLE_DUMP_FRAME");
        if (string.IsNullOrEmpty(path) || File.Exists(path))
            return;
        try
        {
            SaveFrame(bgra, width, height, path);
            DiagLog.Write($"[dump] frame {width}x{height} -> {path}");
        }
        catch (Exception ex)
        {
            DiagLog.Write($"[dump] failed: {ex.Message}");
        }
    }

    private static void SaveFrame(byte[] bgra, int width, int height, string path)
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
    }

}
