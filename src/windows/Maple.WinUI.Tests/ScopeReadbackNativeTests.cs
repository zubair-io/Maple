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
    [Fact]
    public void Cpu_display_buffer_produces_bounded_plots_without_redeveloping_the_photo()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: CPU scope collection requires MAPLE_RAW_FFI_DLL.");
            return;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var pixels = new float[1024 * 2 * 4];
        for (var p = 0; p < 2048; p++) pixels[p * 4 + (p % 1024 < 512 ? 0 : 2)] = 1;
        var readback = new ScopeReadback();
        readback.FromCpu(pixels, 1024, 2);
        var sample = readback.Reduce(42);
        Assert.Equal(42, sample.Version);
        Assert.Equal(512, sample.Values.Take(64).Sum());
        Assert.Equal(256, sample.Values[63]);
        Assert.Equal(256, sample.Values[128 + 63]);
        Assert.Equal(0.2126, sample.Values[192], 10);
        Assert.Equal(0.0722, sample.Values[192 + 63], 10);
        Assert.Equal(2048UL * 255, sample.ChromaBins.Aggregate(0UL, (sum, count) => sum + count));
        Assert.Throws<ArgumentException>(() => readback.FromCpu(new float[3], 1, 1));
    }

    [Fact]
    public void Shared_panel_reducer_preserves_histogram_counts_and_column_values()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: native scope reduction requires MAPLE_RAW_FFI_DLL.");
            return;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        byte[] pixels = [255, 0, 0, 0, 255, 0, 0, 0, 255];
        var values = Enumerable.Repeat(-7.0, 448).ToArray();
        fixed (byte* rgb = pixels)
        fixed (double* plots = values)
        {
            Assert.Equal(-1, RawFfi.maple_scope_panel_reduce(rgb, 9, 3, 1, plots, 447));
            Assert.All(values, value => Assert.Equal(-7.0, value));
            Assert.Equal(-1, RawFfi.maple_scope_panel_reduce(rgb, 8, 3, 1, plots, 448));
            Assert.All(values, value => Assert.Equal(-7.0, value));
            Assert.Equal(0, RawFfi.maple_scope_panel_reduce(rgb, 9, 3, 1, plots, 448));
            Assert.Equal(2, values[0]);
            Assert.Equal(1, values[63]);
            Assert.Equal(0.2126, values[192], 10);
            Assert.Equal(0.7152, values[192 + 21], 10);
            Assert.Equal(0.0722, values[192 + 42], 10);
            Assert.Equal(1, values[256]);
            Assert.Equal(1, values[320 + 21]);
            Assert.Equal(1, values[384 + 42]);
            Assert.Equal(0, RawFfi.maple_scope_panel_reduce(null, 0, 0, 0, plots, 448));
            Assert.All(values, value => Assert.Equal(0, value));
        }
    }

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
            var cpuRgb = new byte[gpu.Length];
            for (var pixel = 0; pixel < 256; pixel++)
            for (var channel = 0; channel < 3; channel++)
                cpuRgb[pixel * 3 + channel] = cpu[pixel * 4 + 2 - channel];
            var cpuPlots = new double[448];
            var gpuPlots = new double[448];
            fixed (byte* cpuPixels = cpuRgb)
            fixed (byte* gpuPixels = snapshot)
            fixed (double* cpuValues = cpuPlots)
            fixed (double* gpuValues = gpuPlots)
            {
                Assert.Equal(0, RawFfi.maple_scope_panel_reduce(cpuPixels, 768, 16, 16, cpuValues, 448));
                Assert.Equal(0, RawFfi.maple_scope_panel_reduce(gpuPixels, 768, 16, 16, gpuValues, 448));
            }
            for (var channel = 0; channel < 3; channel++)
            {
                Assert.Equal(256, cpuPlots.Skip(channel * 64).Take(64).Sum());
                Assert.Equal(256, gpuPlots.Skip(channel * 64).Take(64).Sum());
            }
            for (var value = 192; value < 448; value++)
                Assert.InRange(Math.Abs(cpuPlots[value] - gpuPlots[value]), 0, 2.0 / 255);
        }
        finally
        {
            RawFfi.maple_gpu_live_close(&session);
            Directory.Delete(root, true);
        }
    }
}
