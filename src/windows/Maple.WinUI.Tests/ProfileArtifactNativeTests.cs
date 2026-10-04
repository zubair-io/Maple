using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public unsafe class ProfileArtifactNativeTests
{
    [ProfileArtifactFact]
    public void ProductionDecodeComposesRetainedArtifactsOnceAndPreservesOriginal()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_PROFILE_TEST_RAW")!;
        Assert.True(File.Exists(source), "Embedded-preview RAW fixture must exist.");
        var root = Path.Combine(Path.GetTempPath(), "maple-profile-artifacts-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var raw = Path.Combine(root, Path.GetFileName(source));
        File.Copy(source, raw);
        var original = SHA256.HashData(File.ReadAllBytes(raw));
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
            Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(raw)));
        }
        Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(source)));
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
