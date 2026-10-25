// The Windows live-vs-refine gate of the capture-first chain (#5378, the
// host half of #5377's raw-ffi gate). The Windows host decodes through
// RenderEngine.Decode and builds every tick with MapleGpuLiveParams.From /
// RenderEngine.RenderTick, pointing creative_ptr at the decode's creative
// stage. Both the GPU live chain and the CPU fallback must land within one
// 8-bit step of a fresh sized develop of the same model, on every channel,
// at the as-shot white balance, ±800 K, 2000 K and 50000 K, across the
// capture stages (chroma prefilter, deep denoise, retouch, capture
// sharpening), highlight recovery and auto exposure.
//
// The develop is the scene-linear sized decode with the target white balance
// in its sidecar, encoded by the same CPU chain at an identity white balance.
// The GPU's 8-bit encode rounds a quarter of the channels one step away from
// the CPU's float encode on the scene-linear decode as well, so the gate is
// the maximum step, not the count of differing channels.
//
// Armed by MAPLE_RAW_FFI_DLL plus the RAWs: test-fixtures/raws under the repo
// root, or MAPLE_CAPTURE_TEST_RAWS naming a directory that holds them.

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed unsafe class CaptureLiveRefineNativeTests(ITestOutputHelper output)
{
    private const int Edge = 512;

    [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int maple_render_file_scene_linear_sized_f32(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath,
        uint maxLongEdge, int qualityPreview, IntPtr cancelFlag, MapleSceneLinearBufferF32* outBuffer);

    [DllImport("raw_ffi.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int maple_gpu_live_render(MapleGpuLiveSession* session, MapleGpuLiveParams* p, byte* output);

    [Theory]
    [InlineData("test_0005.RAF")]
    [InlineData("test_0007.DNG")]
    public void LiveWhiteBalanceMatchesRefineWithinOneStep(string fixture)
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL not set.");
            return;
        }
        var path = FixturePath(fixture);
        if (path == null)
        {
            output.WriteLine($"SKIP-PASS: {fixture} not found (test-fixtures/raws or MAPLE_CAPTURE_TEST_RAWS).");
            return;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var worst = 0;
        foreach (var (combination, decodeModel) in Combinations())
        {
            var image = RenderEngine.Decode(path, decodeModel, Edge, RefineDecodeQuality.Preview, IntPtr.Zero);
            Assert.NotNull(image.Creative);
            var session = new MapleGpuLiveSession();
            fixed (float* pixels = image.Pixels)
                Assert.True(RawFfi.maple_gpu_live_open(pixels, (uint)image.Width, (uint)image.Height, &session) == 0,
                    RawFfi.LastError());
            try
            {
                foreach (var (target, temperature, tint) in Targets(image))
                {
                    var model = decodeModel.Clone();
                    model.Temperature = temperature;
                    model.Tint = tint;
                    var refined = Refine(path, model, image);
                    var gpu = Gpu(&session, image, model);
                    var cpu = Cpu(image, model);
                    var (gpuStep, gpuMoved) = Compare(gpu, refined);
                    var (cpuStep, cpuMoved) = Compare(cpu, refined);
                    output.WriteLine($"{fixture} [{combination} @ {target}] {image.Width}x{image.Height} " +
                        $"GPU live vs refine: max step {gpuStep}, {gpuMoved}/{refined.Length} channels differ; " +
                        $"CPU vs refine: max step {cpuStep}, {cpuMoved} differ; ae_gain {image.AeGain:0.####}");
                    worst = Math.Max(worst, Math.Max(gpuStep, cpuStep));
                    Assert.True(gpuStep <= 1, $"{fixture} [{combination} @ {target}]: GPU live {gpuStep} steps");
                    Assert.True(cpuStep <= 1, $"{fixture} [{combination} @ {target}]: CPU {cpuStep} steps");
                }
            }
            finally { RawFfi.maple_gpu_live_close(&session); }
        }
        output.WriteLine($"{fixture}: worst live-vs-refine step {worst}");
    }

    private static string? FixturePath(string name)
    {
        var dirs = new[]
        {
            Environment.GetEnvironmentVariable("MAPLE_CAPTURE_TEST_RAWS"),
            RepoPaths.FindRepoRoot() is { } root ? Path.Combine(root, "test-fixtures", "raws") : null,
        };
        return dirs.Where(d => !string.IsNullOrEmpty(d)).Select(d => Path.Combine(d!, name)).FirstOrDefault(File.Exists);
    }

    /// <summary>The decode-level combinations of the raw-ffi gate. The detail
    /// tail is off so the comparison isolates the creative stage.</summary>
    private static IEnumerable<(string, AdjustmentState)> Combinations()
    {
        AdjustmentState Model(Action<AdjustmentState> edit)
        {
            var model = new AdjustmentState
            {
                Profile = ProfileMode.Neutral, SharpenAmount = 0, NrLuminance = 0, NrColor = 0,
            };
            edit(model);
            return model;
        }
        void EveryStage(AdjustmentState m)
        {
            m.ChromaPrefilter = 60;
            m.DeepDenoise = 50;
            m.Retouch = XmpRetouch.Add(m.Retouch, new RetouchSpot(RetouchKind.Heal, .42, .4, .62, .58, .06));
            m.CaptureSharpeningAmount = 80;
            m.HighlightRecovery = HighlightRecoveryMode.OklabChromaReduction;
        }
        yield return ("plain", Model(_ => { }));
        yield return ("hr-off", Model(m => m.HighlightRecovery = HighlightRecoveryMode.Off));
        yield return ("chroma", Model(m => m.ChromaPrefilter = 60));
        yield return ("denoise", Model(m => m.DeepDenoise = 50));
        yield return ("retouch", Model(m => m.Retouch = XmpRetouch.Add(m.Retouch,
            new RetouchSpot(RetouchKind.Heal, .42, .4, .62, .58, .06))));
        yield return ("sharpening", Model(m => m.CaptureSharpeningAmount = 80));
        yield return ("oklab-recovery", Model(m => m.HighlightRecovery = HighlightRecoveryMode.OklabChromaReduction));
        yield return ("ae-off", Model(m => m.AutoExposure = ToggleMode.Off));
        yield return ("every-stage", Model(EveryStage));
        yield return ("every-stage-ae-off", Model(m => { EveryStage(m); m.AutoExposure = ToggleMode.Off; }));
    }

    private static IEnumerable<(string, double, double)> Targets(DecodedImage image)
    {
        Assert.True(image.DecodedTemperature > 0, "the fixture must carry a slider frame");
        var (cct, tint) = (image.DecodedTemperature, image.DecodedTint);
        return
        [
            ("as-shot", cct, tint),
            ("+800K", cct + 800, tint),
            ("-800K", cct - 800, tint),
            ("2000K", 2000, tint),
            ("50000K", 50000, tint),
        ];
    }

    /// <summary>A fresh sized develop of <paramref name="model"/>: its white
    /// balance in the decode, then the same CPU chain at identity.</summary>
    private static byte[] Refine(string path, AdjustmentState model, DecodedImage live)
    {
        var decodeModel = RenderEngine.StripChainStages(model);
        decodeModel.Temperature = model.Temperature;
        decodeModel.Tint = model.Tint;
        var xmp = Path.Combine(Path.GetTempPath(), $"maple-refine-{Guid.NewGuid():N}.xmp");
        File.WriteAllText(xmp, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = decodeModel }));
        var buffer = new MapleSceneLinearBufferF32();
        try
        {
            var rc = maple_render_file_scene_linear_sized_f32(path, xmp, Edge, RefineDecodeQuality.Preview,
                IntPtr.Zero, &buffer);
            Assert.True(rc == 0, RawFfi.LastError());
            Assert.Equal((uint)live.Width, buffer.width);
            Assert.Equal((uint)live.Height, buffer.height);
            var count = live.Width * live.Height * 4;
            var image = new DecodedImage
            {
                Pixels = new ReadOnlySpan<float>(buffer.f32_rgba, count).ToArray(),
                Width = live.Width, Height = live.Height,
                NoiseProfile = new ReadOnlySpan<float>(buffer.noise_profile_data, (int)buffer.noise_profile_len).ToArray(),
                Iso = buffer.iso, AeGain = buffer.ae_gain, WhitesAnchorEv = buffer.whites_anchor_ev,
                NrSamplingScale = buffer.nr_sampling_scale,
                DecodedTemperature = (float)model.Temperature, DecodedTint = (float)model.Tint,
            };
            return Cpu(image, model);
        }
        finally
        {
            RawFfi.maple_free_scene_linear_buffer_f32(&buffer);
            File.Delete(xmp);
        }
    }

    private static byte[] Gpu(MapleGpuLiveSession* session, DecodedImage image, AdjustmentState model)
    {
        var p = MapleGpuLiveParams.From(model, image);
        var rgb = new byte[image.Width * image.Height * 3];
        fixed (float* noise = image.NoiseProfile)
        fixed (MapleCaptureCreative* creative = image.Creative)
        fixed (byte* output = rgb)
        {
            p.creative_ptr = creative;
            if (image.NoiseProfile.Length > 0)
            {
                p.noise_profile_ptr = noise;
                p.noise_profile_len = (uint)image.NoiseProfile.Length;
            }
            Assert.True(maple_gpu_live_render(session, &p, output) == 0, RawFfi.LastError());
        }
        return rgb;
    }

    private static byte[] Cpu(DecodedImage image, AdjustmentState model)
    {
        float[]? scratch = null;
        var bgra = new byte[image.Width * image.Height * 4];
        RenderEngine.RenderTick(image, model, ref scratch, bgra);
        var rgb = new byte[image.Width * image.Height * 3];
        for (int i = 0, o = 0; o < rgb.Length; i += 4, o += 3)
        {
            rgb[o] = bgra[i + 2];
            rgb[o + 1] = bgra[i + 1];
            rgb[o + 2] = bgra[i];
        }
        return rgb;
    }

    private static (int Step, int Moved) Compare(byte[] shown, byte[] refined)
    {
        Assert.Equal(refined.Length, shown.Length);
        var (step, moved) = (0, 0);
        for (var i = 0; i < shown.Length; i++)
        {
            var d = Math.Abs(shown[i] - refined[i]);
            step = Math.Max(step, d);
            moved += d == 0 ? 0 : 1;
        }
        return (step, moved);
    }
}
