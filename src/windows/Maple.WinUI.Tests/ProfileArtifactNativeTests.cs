using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public class ProfileArtifactNativeTests
{
    [ProfileArtifactFact]
    public unsafe void ProductionFitUsesSizedRenderBoundaryAndRejectsOtherCalibrationContexts()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_PROFILE_TEST_RAW")!;
        var original = SHA256.HashData(File.ReadAllBytes(source));
        var model = new AdjustmentState();
        var decoded = RenderEngine.Decode(source, model, 1600, RefineDecodeQuality.Preview, IntPtr.Zero);
        Assert.Equal(new ProfileFitContext(1600, RefineDecodeQuality.Preview), decoded.ProfileFit);
        var curve = new float[220];
        var residual = new float[33 * 33 * 33 * 3];
        int present;
        uint size;
        fixed (float* curvePtr = curve)
        fixed (float* residualPtr = residual)
            Assert.Equal(0, RawFfi.maple_gpu_fit_auto_profile_at_render_size(
                source, null, RefineDecodeQuality.Preview, 1600,
                curvePtr, &present, residualPtr, (nuint)residual.Length, &size));
        Assert.Equal(present == 0 ? null : curve, decoded.ProfileCurve);
        Assert.Equal(size, decoded.ResidualLutSize);
        Assert.Equal(size == 0 ? null : residual.AsSpan(0, checked((int)(size * size * size * 3))).ToArray(), decoded.ResidualLut);
        var retained = decoded.DisplayLut;
        Assert.NotNull(retained);
        var upgrade = RenderEngine.Decode(source, model, 1600, RefineDecodeQuality.Amaze, IntPtr.Zero, decoded);
        Assert.Same(retained, upgrade.DisplayLut);
        Assert.Equal(decoded.ProfileFit, upgrade.ProfileFit);
        var smaller = RenderEngine.Decode(source, model, 800, RefineDecodeQuality.Preview, IntPtr.Zero, decoded);
        Assert.NotSame(retained, smaller.DisplayLut);
        Assert.Equal(new ProfileFitContext(800, RefineDecodeQuality.Preview), smaller.ProfileFit);
        decoded.ProfileFit = new(1600, RefineDecodeQuality.Amaze);
        Assert.NotSame(retained, RenderEngine.Decode(source, model, 1600, RefineDecodeQuality.Preview, IntPtr.Zero, decoded).DisplayLut);
        decoded.ProfileFit = null;
        Assert.NotSame(retained, RenderEngine.Decode(source, model, 1600, RefineDecodeQuality.Preview, IntPtr.Zero, decoded).DisplayLut);
        Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(source)));
    }

    [NativeComposeFact]
    public unsafe void ResidualOnlyCompositionPreservesWhiteAcrossNativeBinding()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var residual = new float[24];
        for (var b = 0; b < 2; b++)
            for (var g = 0; g < 2; g++)
                for (var r = 0; r < 2; r++)
                {
                    var offset = ((b * 2 + g) * 2 + r) * 3;
                    residual[offset] = r;
                    residual[offset + 1] = g;
                    residual[offset + 2] = b;
                }
        var output = Enumerable.Repeat(-7f, 24).ToArray();
        fixed (float* input = residual)
        fixed (float* destination = output)
            Assert.Equal(0, RawFfi.maple_compose_auto_profile_lut(null, 0, input,
                (nuint)residual.Length, 2, 2, destination, (nuint)output.Length));
        Assert.Equal(residual, output);
        Assert.Equal(new[] { 1f, 1f, 1f }, output[^3..]);
    }

    [NativeComposeFact]
    public unsafe void ComposeOptionalAndInvalidTailsPreserveDestination()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var output = Enumerable.Repeat(-7f, 24).ToArray();
        var original = (float[])output.Clone();
        fixed (float* destination = output)
        {
            Assert.Equal(1, RawFfi.maple_compose_auto_profile_lut(null, 0, null, 0, 0,
                2, destination, (nuint)output.Length));
            Assert.Equal(original, output);
            Assert.Equal(-1, RawFfi.maple_compose_auto_profile_lut(null, 1, null, 0, 0,
                2, destination, (nuint)output.Length));
            Assert.Equal(original, output);
            Assert.Equal(-1, RawFfi.maple_compose_auto_profile_lut(null, 0, null, 0, 0,
                uint.MaxValue, destination, (nuint)output.Length));
            Assert.Equal(original, output);
        }
    }

    [ProfileArtifactFact]
    public unsafe void ProductionDecodeSharesRetainedArtifactsAndPreservesOriginal()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_PROFILE_TEST_RAW")!;
        Assert.True(File.Exists(source), "Embedded-preview RAW fixture must exist.");
        var root = Path.Combine(Path.GetTempPath(), "maple-profile-artifacts-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var raw = Path.Combine(root, Path.GetFileName(source));
        try
        {
            File.Copy(source, raw);
            var original = HashFile(raw);
            var sidecar = Path.ChangeExtension(raw, ".xmp");
            File.WriteAllText(sidecar, "<x:xmpmeta xmlns:x='adobe:ns:meta/'>"
                + "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
                + "<rdf:Description xmlns:audit='urn:maple:test:unknown' audit:Keep='unchanged'/></rdf:RDF></x:xmpmeta>");
            var originalSidecar = File.ReadAllBytes(sidecar);
            foreach (var exposure in new[] { 0.0, .45 })
            {
                var model = new AdjustmentState { Exposure = exposure, Profile = ProfileMode.Auto };
                var decoded = RenderEngine.Decode(raw, model, 1600, RefineDecodeQuality.Preview, IntPtr.Zero);
                Assert.True(decoded.ProfileCurve != null || decoded.ResidualLut != null,
                    "This fixture must engage Auto Profile; a no-tail render does not qualify artifact reuse.");
                Assert.NotNull(decoded.DisplayLut);
                Assert.Equal(33, decoded.DisplayLutN);
                var expected = new float[33 * 33 * 33 * 3];
                fixed (float* curve = decoded.ProfileCurve)
                fixed (float* residual = decoded.ResidualLut)
                fixed (float* output = expected)
                    Assert.Equal(0, RawFfi.maple_compose_auto_profile_lut(
                        curve, (nuint)(decoded.ProfileCurve?.Length ?? 0),
                        residual, (nuint)(decoded.ResidualLut?.Length ?? 0), decoded.ResidualLutSize,
                        33, output, (nuint)expected.Length));
                Assert.Equal(expected, decoded.DisplayLut);
                var retained = decoded.DisplayLut;
                var pixels = new byte[decoded.Width * decoded.Height * 4];
                float[]? scratch = null;
                RenderEngine.RenderTick(decoded, model, ref scratch, pixels);
                model.Exposure += .01;
                RenderEngine.RenderTick(decoded, model, ref scratch, pixels);
                Assert.Same(retained, decoded.DisplayLut);
                Assert.Equal(expected, decoded.DisplayLut);
                Assert.Equal(originalSidecar, File.ReadAllBytes(sidecar));
                Assert.Equal(original, HashFile(raw));
            }
            Assert.Equal(original, HashFile(source));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static byte[] HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return SHA256.HashData(stream);
    }

    private sealed class NativeComposeFactAttribute : FactAttribute
    {
        public NativeComposeFactAttribute()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
                Skip = "Requires the built shared-core DLL; no RAW fixture required.";
        }
    }

    [ProfileArtifactFact]
    public void ProductionDecodeRejectsUnrelatedChangedAndUnqualifiedDonors()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_PROFILE_TEST_RAW")!;
        var root = Path.Combine(Path.GetTempPath(), "maple-profile-reuse-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var raw = Path.Combine(root, Path.GetFileName(source));
        var other = Path.Combine(root, "other" + Path.GetExtension(source));
        try
        {
            File.Copy(source, raw);
            File.Copy(source, other);
            var original = HashFile(source);
            var model = new AdjustmentState();
            DecodedImage Decode(string path, DecodedImage? donor = null) =>
                RenderEngine.Decode(path, model, 1600, RefineDecodeQuality.Preview, IntPtr.Zero, donor);
            var fitted = Decode(raw);
            Assert.NotNull(fitted.DisplayLut);
            Assert.NotNull(fitted.ProfileSource);
            var reused = Decode(raw.Replace('\\', '/'), fitted);
            Assert.Same(fitted.DisplayLut, reused.DisplayLut);
            var half = RenderEngine.DownsampleHalf(fitted);
            Assert.Equal(fitted.ProfileSource, half.ProfileSource);
            Assert.Equal(fitted.ProfileFit, half.ProfileFit);
            Assert.Same(fitted.DisplayLut, Decode(raw, half).DisplayLut);
            Assert.NotSame(fitted.DisplayLut, Decode(other, fitted).DisplayLut);
            File.SetLastWriteTimeUtc(raw, File.GetLastWriteTimeUtc(raw).AddSeconds(5));
            var changed = Decode(raw, fitted);
            Assert.NotSame(fitted.DisplayLut, changed.DisplayLut);
            changed.ProfileSource = null; // An unqualified/failed fit cannot donate even if arrays exist.
            Assert.NotSame(changed.DisplayLut, Decode(raw, changed).DisplayLut);
            Assert.Equal(original, HashFile(raw));
            Assert.Equal(original, HashFile(other));
            Assert.Equal(original, HashFile(source));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void SourceGenerationRejectsLengthChangesEvenWhenTimestampIsPreserved()
    {
        var path = Path.Combine(Path.GetTempPath(), "maple-profile-generation-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllText(path, "first");
            var before = ProfileSourceGeneration.Read(path);
            File.AppendAllText(path, "longer");
            File.SetLastWriteTimeUtc(path, new DateTime(before.Modified, DateTimeKind.Utc));
            Assert.False(before.Matches(ProfileSourceGeneration.Read(path)));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void PostDecodeSourceValidationRejectsRenamedOrDeletedFilesWithoutThrowing()
    {
        var path = Path.Combine(Path.GetTempPath(), "maple-profile-disappeared-" + Guid.NewGuid().ToString("N"));
        var renamed = path + ".renamed";
        try
        {
            File.WriteAllText(path, "source");
            var source = ProfileSourceGeneration.Read(path);
            Assert.True(source.StillCurrent(path));
            File.Move(path, renamed);
            Assert.False(source.StillCurrent(path));
            File.Move(renamed, path);
            Assert.True(source.StillCurrent(path));
            File.Delete(path);
            Assert.False(source.StillCurrent(path));
        }
        finally { File.Delete(path); File.Delete(renamed); }
    }

    [DemosaicNativeFact]
    public async Task NoEmbeddedPreviewRetainsValidNoTailOwnershipInNativeDetail()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        var model = new AdjustmentState { AutoLateralCa = ToggleMode.Off };
        var decoded = RenderEngine.Decode(source, model, 32, RefineDecodeQuality.Preview, IntPtr.Zero);
        Assert.Null(decoded.DisplayLut);
        Assert.Null(decoded.ProfileCurve);
        Assert.Null(decoded.ResidualLut);
        Assert.NotNull(decoded.ProfileSource);
        var reused = RenderEngine.Decode(source, model, 32, RefineDecodeQuality.Preview, IntPtr.Zero, decoded);
        Assert.Equal(decoded.ProfileSource, reused.ProfileSource);
        await using var detail = new NativeDetailDecoder();
        var patch = await detail.DecodeAsync(source, model, decoded, new(0, 0, 16, 16), default);
        Assert.Equal(decoded.ProfileSource, patch.Image.ProfileSource);
        Assert.Equal(decoded.ProfileFit, patch.Image.ProfileFit);
        Assert.Null(patch.Image.DisplayLut);
    }

    private sealed class ProfileArtifactFactAttribute : FactAttribute
    {
        public ProfileArtifactFactAttribute()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL"))
                || string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_PROFILE_TEST_RAW")))
                Skip = "Requires the built shared-core DLL and an embedded-preview RAW fixture.";
        }
    }
}
