using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed unsafe class ScopeReadbackNativeTests(ITestOutputHelper output)
{
    [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int maple_gpu_live_render(MapleGpuLiveSession* session, MapleGpuLiveParams* p, byte* output);

    [Fact]
    public void Final_gpu_scope_sample_matches_cpu_display_and_is_consumed_once()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: native scope readback requires MAPLE_RAW_FFI_DLL.");
            return;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var root = Path.Combine(Path.GetTempPath(), "maple-scope-native-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var session = new MapleGpuLiveSession();
        try
        {
            var source = ExportRasterNativeTests.WriteTiff(root);
            var model = new AdjustmentState { Exposure = 0.5, SharpenAmount = 0, NrColor = 0 };
            var image = RenderEngine.Decode(source, model, 16, 0, IntPtr.Zero);
            fixed (float* pixels = image.Pixels)
                Assert.Equal(0, RawFfi.maple_gpu_live_open(pixels, 16, 16, &session));
            var p = MapleGpuLiveParams.From(model, image);
            p.scope_enabled = 1;
            p.scope_layer = -1;
            var gpu = new byte[16 * 16 * 3];
            fixed (byte* rgb = gpu)
                Assert.Equal(0, maple_gpu_live_render(&session, &p, rgb));
            var bins = new uint[128 * 128];
            var snapshot = new byte[512 * 512 * 3];
            fixed (uint* b = bins)
            fixed (byte* rgb = snapshot)
            {
                var stats = new MapleScopeStats { bins_ptr = b, bins_len = (uint)bins.Length,
                    snapshot_ptr = rgb, snapshot_len = (uint)snapshot.Length };
                stats.bins_len = 1;
                Assert.Equal(-2, RawFfi.maple_gpu_live_poll_scope(&session, &stats));
                Assert.Equal(0UL, stats.frame);
                stats.bins_len = (uint)bins.Length;
                Assert.Equal(1, RawFfi.maple_gpu_live_poll_scope(&session, &stats));
                Assert.Equal(1UL, stats.frame);
                Assert.Equal(16u, stats.snapshot_width);
                Assert.Equal(16u, stats.snapshot_height);
                Assert.Equal((ulong)stats.total, bins.Aggregate(0UL, (sum, count) => sum + count));
                Assert.Equal(0, RawFfi.maple_gpu_live_poll_scope(&session, &stats));
                Assert.Equal(1UL, stats.frame);
            }
            float[]? scratch = null;
            var cpu = new byte[16 * 16 * 4];
            RenderEngine.RenderTick(image, model, ref scratch, cpu);
            for (var pixel = 0; pixel < 16 * 16; pixel++)
            for (var channel = 0; channel < 3; channel++)
            {
                Assert.InRange(Math.Abs(snapshot[pixel * 3 + channel] - gpu[pixel * 3 + channel]), 0, 2);
                Assert.InRange(Math.Abs(snapshot[pixel * 3 + channel] - cpu[pixel * 4 + 2 - channel]), 0, 2);
            }
        }
        finally
        {
            RawFfi.maple_gpu_live_close(&session);
            Directory.Delete(root, true);
        }
    }
}
