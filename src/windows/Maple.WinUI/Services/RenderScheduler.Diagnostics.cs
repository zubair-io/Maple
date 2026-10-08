using System;
using System.IO;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    // #4329: diagnostic readback runs only in a separate parity process. Use
    // an isolated GPU session so the readback render cannot mutate the live
    // present session's pooled pass/bind-group state.
    private static unsafe void DumpGpuFrameIfRequested(
        Native.MapleGpuLiveParams* parameters,
        DecodedImage image, Models.AdjustmentState state, ulong generation)
    {
        var path = Environment.GetEnvironmentVariable("MAPLE_DUMP_GPU_FRAME");
        if (string.IsNullOrEmpty(path) || File.Exists(path)) return;
        try
        {
            CaptureGpuFrame(parameters, image, state, generation, path);
        }
        catch (Exception error)
        {
            // A diagnostic failure must not fault the renderer or its shutdown.
            DiagLog.Write($"[dump-gpu] failed: {error}");
            try
            {
                File.WriteAllText(path + ".error.json", System.Text.Json.JsonSerializer.Serialize(
                    new { backend = "gpu", error = error.Message }));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static unsafe void CaptureGpuFrame(
        Native.MapleGpuLiveParams* parameters,
        DecodedImage image, Models.AdjustmentState state, ulong generation, string path)
    {
        var rgb = new byte[checked(image.Width * image.Height * 3)];
        var diagnostic = default(Native.MapleGpuLiveSession);
        var captureParameters = *parameters;
        // Scope readback is owned by the production present path. The parity
        // render only needs pixels; polling the same async scope state a second
        // time can race the present's scope submission bookkeeping.
        captureParameters.scope_enabled = 0;
        captureParameters.scope_out = null;
        Native.MapleGpuLiveParams* captureParams = &captureParameters;
        Native.MapleGpuLiveSession* session = &diagnostic;
        fixed (byte* output = rgb)
        fixed (float* pixels = image.Pixels)
        {
            var rc = Native.RawFfi.maple_gpu_live_open(pixels, (uint)image.Width, (uint)image.Height, session);
            if (rc != 0)
                throw new InvalidOperationException($"GPU parity session open rc={rc}: {Native.RawFfi.LastError()}");
            try
            {
                rc = Native.RawFfi.maple_gpu_live_render(session, captureParams, output);
                if (rc != 0)
                    throw new InvalidOperationException($"GPU parity readback rc={rc}: {Native.RawFfi.LastError()}");
            }
            finally
            {
                Native.RawFfi.maple_gpu_live_close(session);
                diagnostic.inner = IntPtr.Zero;
            }
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
        File.WriteAllText(path + ".json", System.Text.Json.JsonSerializer.Serialize(new
        {
            backend = "gpu", scope = "bounded develop chain; canvas framing excluded",
            width = image.Width, height = image.Height, generation,
            exposure = state.Exposure, profile = state.Profile.ToString(),
            film = state.FilmLook, film_strength = state.FilmStrength,
            profile_curve_length = image.ProfileCurve?.Length ?? 0,
            residual_lut_size = image.ResidualLutSize,
        }));
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
