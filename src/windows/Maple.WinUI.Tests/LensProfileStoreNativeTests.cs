// LensProfileStoreNativeTests — the editor-side store paths against the real
// core (#3480): import → store → forget (an isolated worker's clear) →
// restore-before-decode through RenderEngine.Decode itself, the resolved
// per-family coverage the Lens panel enables its rows from, and the two
// refusals that no acknowledgement may bypass: a camera/lens mismatch and a
// reference this device never held. Armed by MAPLE_RAW_FFI_DLL like
// RawFfiLayoutTests; skip-passes without it.

using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class LensProfileStoreNativeTests(ITestOutputHelper output)
{
    private bool NativeAvailable()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL not set; the native lens-profile store was not exercised.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        return true;
    }

    [Fact]
    public void Import_stores_exact_bytes_and_a_forgotten_profile_is_restored_before_decode()
    {
        if (!NativeAvailable()) return;
        using var fixture = new ExportLensProfileFixture();
        var profile = ExportLensProfileFixture.Profile();
        var lcp = Path.Combine(fixture.Root, "prime.lcp");
        File.WriteAllBytes(lcp, profile);
        var imported = LensProfileStore.Import(lcp, fixture.RawPath);
        var stored = LensProfileStore.StoredPath(imported.Reference);
        try
        {
            Assert.Equal(profile, File.ReadAllBytes(stored));
            Assert.Equal(ExportLensProfileFixture.Make, imported.Make);
            Assert.Equal(ExportLensProfileFixture.Model, imported.Camera);
            Assert.Equal(ExportLensProfileFixture.Lens, imported.Lens);
            Assert.Equal("Maple test prime", imported.Name);
            Assert.Equal(1, imported.SampleCount);
            Assert.True(imported.Resolution.Imported);
            Assert.False(imported.Resolution.Approximate);
            Assert.True(imported.Resolution.HasVignetting);
            Assert.False(imported.Resolution.HasCa);
            Assert.Contains(imported.Resolution.Samples, s => s.Family == "vignetting" && s.FocalMm == 35);

            // An isolated worker forgets everything between jobs; the shell
            // must then get the profile back from the store, not from luck.
            LensProfileStore.ClearNativeCache();
            Assert.Null(LensProfileStore.AssessForFile(fixture.RawPath, imported.Reference));

            var model = new AdjustmentState { LensProfile = imported.AcknowledgedReference };
            var cancel = RawFfi.maple_cancel_flag_new();
            try
            {
                var decoded = RenderEngine.Decode(fixture.RawPath, model, 64, RefineDecodeQuality.Preview, cancel);
                // Preview quality is the 2×2-binned half-res demosaic.
                Assert.InRange(Math.Max(decoded.Width, decoded.Height), 32, 64);
                Assert.NotNull(decoded.LensProfile);
                Assert.True(decoded.LensProfile!.Imported);
                Assert.True(decoded.LensProfile.HasVignetting);
                // The fixture's PerspectiveModel carries a (zero) radial term,
                // so distortion is a covered family; chromatic aberration is not.
                Assert.True(decoded.LensProfile.HasDistortion);
                Assert.False(decoded.LensProfile.HasCa);
            }
            finally { RawFfi.maple_cancel_flag_free(cancel); }
            output.WriteLine("Actual native store: imported bytes stored under their digest, cleared from the process, restored by RenderEngine.Decode.");
        }
        finally
        {
            if (File.Exists(stored))
            {
                Assert.Equal(profile, File.ReadAllBytes(stored));
                File.Delete(stored);
            }
        }
    }

    [Fact]
    public void Mismatched_profile_is_refused_and_acknowledgement_cannot_bypass_it()
    {
        if (!NativeAvailable()) return;
        using var fixture = new ExportLensProfileFixture();
        var profile = ExportLensProfileFixture.Profile(model: "Some Other Body");
        var lcp = Path.Combine(fixture.Root, "other.lcp");
        File.WriteAllBytes(lcp, profile);

        var refused = Assert.Throws<LensProfileException>(() => LensProfileStore.Import(lcp, fixture.RawPath));
        Assert.Contains("No exact camera/lens", refused.Message);

        // Import registered the bytes before resolving, so the reference is
        // known to the process — and still unusable, acknowledged or not.
        var bytes = File.ReadAllBytes(lcp);
        var code = RawFfi.maple_lens_profile_register(bytes, (nuint)bytes.Length, out var json);
        string reference;
        try
        {
            Assert.Equal(0, code);
            using var document = System.Text.Json.JsonDocument.Parse(System.Runtime.InteropServices.Marshal.PtrToStringUTF8(json)!);
            reference = document.RootElement.GetProperty("reference").GetString()!;
        }
        finally { RawFfi.maple_free_lens_profile_json(json); }
        Assert.False(File.Exists(LensProfileStore.StoredPath(reference)), "A profile that does not match must not be stored.");
        var acknowledged = Assert.Throws<LensProfileException>(() => LensProfileStore.RestoreForFile(
            fixture.RawPath, new AdjustmentState { LensProfile = LensProfileStore.Acknowledge(reference) }));
        Assert.Contains("No exact camera/lens", acknowledged.Message);

        // A digest this device never held, enabled, is the explicit
        // "missing" error rather than a silent render without correction.
        var missing = Assert.Throws<LensProfileException>(() => LensProfileStore.RestoreForFile(
            fixture.RawPath, new AdjustmentState { LensProfile = "lcp1-ack:" + new string('c', 64) }));
        Assert.Contains("missing from this device", missing.Message);
        output.WriteLine("Actual native refusals: mismatch refused on import and on restore (acknowledged), unknown digest reported missing.");
    }

    /// <summary>The profile dropdown's compatible-lens list (#3564/#3568)
    /// against the real core: the fixture's synthetic "Maple Test / Cold
    /// Export Fixture" body matches nothing in the bundled Lensfun database,
    /// so `maple_lens_profile_compatible` must succeed with an empty list —
    /// never an error — and an automatic-match resolve (empty reference)
    /// against that same unmatched body reports source "none".</summary>
    [Fact]
    public void Compatible_lenses_is_empty_and_automatic_match_reports_none_for_an_unmatched_body()
    {
        if (!NativeAvailable()) return;
        using var fixture = new ExportLensProfileFixture();

        var compatible = LensProfileStore.Compatible(fixture.RawPath);
        Assert.Empty(compatible);

        var auto = LensProfileStore.AssessForFile(fixture.RawPath, "");
        Assert.NotNull(auto);
        Assert.False(auto!.Lensfun);
        output.WriteLine("Actual native lookup: an unmatched camera body returns [] compatible lenses and a non-lensfun automatic match.");
    }
}
