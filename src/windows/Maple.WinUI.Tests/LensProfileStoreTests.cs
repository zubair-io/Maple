// LensProfileStoreTests — the WinUI-free half of the imported-LCP store
// (#2435 / #3480) that needs no native core: reference validation (a
// sidecar value must never be able to name a file outside the store), the
// "needs the profile bytes at all" rule that mirrors raw-core's
// `corrections_enabled`, the resolve-JSON → record mapping, and the
// decode-owned invalidation of every lens field. The paths that actually
// call raw_ffi are covered by ExportLensProfileNativeTests under
// MAPLE_RAW_FFI_DLL.

using System.Text.Json;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class LensProfileStoreTests
    {
        private static readonly string Digest = new('b', 64);

        [Theory]
        [InlineData("lcp1:", false)]
        [InlineData("lcp1-ack:", true)]
        public void DigestAndAcknowledgementReadBothSpellings(string prefix, bool acknowledged)
        {
            var reference = prefix + Digest;
            Assert.Equal(Digest, LensProfileStore.Digest(reference));
            Assert.Equal(acknowledged, LensProfileStore.IsAcknowledged(reference));
            Assert.Equal("lcp1-ack:" + Digest, LensProfileStore.Acknowledge(reference));
            Assert.Equal(
                Path.Combine(LensProfileStore.DirectoryPath, Digest + ".lcp"),
                LensProfileStore.StoredPath(reference));
        }

        [Theory]
        [InlineData("")]
        [InlineData("../profile.lcp")]
        [InlineData("lcp1:../profile.lcp")]
        [InlineData("lcp2:abc")]
        [InlineData("lcp1:ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")]
        [InlineData("lcp1:abc")]
        [InlineData("lcp1-ack:")]
        public void MalformedReferencesCannotNameAFile(string value)
        {
            Assert.Throws<LensProfileException>(() => LensProfileStore.Digest(value));
            Assert.Throws<LensProfileException>(() => LensProfileStore.StoredPath(value));
            Assert.False(LensProfileStore.IsAcknowledged(value));
        }

        [Fact]
        public void ProfileBytesAreNeededOnlyForAnEnabledNonZeroSelection()
        {
            var reference = "lcp1:" + Digest;
            Assert.False(LensProfileStore.RequiresProfile(new AdjustmentState()));
            Assert.True(LensProfileStore.RequiresProfile(new AdjustmentState { LensProfile = reference }));
            Assert.False(LensProfileStore.RequiresProfile(new AdjustmentState
            {
                LensProfile = reference, LensProfileEnable = ToggleMode.Off,
            }));
            Assert.False(LensProfileStore.RequiresProfile(new AdjustmentState
            {
                LensProfile = reference,
                LensCorrectionDistortion = 0, LensCorrectionCa = 0, LensCorrectionVignetting = 0,
            }));
            Assert.True(LensProfileStore.RequiresProfile(new AdjustmentState
            {
                LensProfile = reference,
                LensCorrectionDistortion = 0, LensCorrectionCa = 0, LensCorrectionVignetting = 5,
            }));
        }

        [Fact]
        public void DisabledOrZeroStrengthSelectionsRestoreWithoutTouchingTheCore()
        {
            // No raw_ffi is loaded in this suite: a native call here would
            // throw DllNotFoundException, so completing is the assertion.
            var reference = "lcp1:" + Digest;
            LensProfileStore.RestoreForFile("missing.dng", new AdjustmentState());
            LensProfileStore.RestoreForFile("missing.dng", new AdjustmentState
            {
                LensProfile = reference, LensProfileEnable = ToggleMode.Off,
            });
            LensProfileStore.RestoreForFile("missing.dng", new AdjustmentState
            {
                LensProfile = reference,
                LensCorrectionDistortion = 0, LensCorrectionCa = 0, LensCorrectionVignetting = 0,
            });
        }

        [Fact]
        public void ResolveJsonMapsToTheResolutionRecord()
        {
            using var document = JsonDocument.Parse("""
                {"source":"lcp","confidence":"approximate",
                 "hasDistortion":true,"hasCa":false,"hasVignetting":true,
                 "approximations":["focal 24 mm below calibrated 35 mm"],
                 "unsupported":["Sample 2: Version2PerspectiveModel"],
                 "distortion":[{"index":0,"weight":0.75,"focalMm":35,"apertureApex":4,"focusM":null},
                               {"index":1,"weight":0.25,"focalMm":50,"apertureApex":4,"focusM":2.5}],
                 "ca":[],
                 "vignetting":[{"index":0,"weight":1,"focalMm":35,"apertureApex":4,"focusM":null}]}
                """);
            var resolution = LensProfileStore.ParseResolution(document.RootElement);

            Assert.True(resolution.Imported);
            Assert.True(resolution.Approximate);
            Assert.True(resolution.HasDistortion);
            Assert.False(resolution.HasCa);
            Assert.True(resolution.HasVignetting);
            Assert.Equal(new[] { "focal 24 mm below calibrated 35 mm" }, resolution.Approximations);
            Assert.Equal(new[] { "Sample 2: Version2PerspectiveModel" }, resolution.Unsupported);
            Assert.Collection(resolution.Samples,
                s => { Assert.Equal("distortion", s.Family); Assert.Equal(35, s.FocalMm); Assert.Null(s.FocusM); Assert.Equal(0.75, s.Weight); },
                s => { Assert.Equal("distortion", s.Family); Assert.Equal(2.5, s.FocusM); },
                s => { Assert.Equal("vignetting", s.Family); Assert.Equal(1, s.Weight); });

            var text = resolution.Describe();
            Assert.Contains("approximate", text);
            Assert.Contains("Covers: distortion, vignetting", text);
            Assert.Contains("Approximation: focal 24 mm below calibrated 35 mm", text);
            Assert.Contains("Unsupported: Sample 2: Version2PerspectiveModel", text);
        }

        [Theory]
        [InlineData("embedded", true, "embedded lens corrections apply")]
        [InlineData("none", false, "no lens correction data")]
        public void EmbeddedAndAbsentStatesDescribeThemselves(string source, bool embedded, string expected)
        {
            using var document = JsonDocument.Parse(
                $$"""{"source":"{{source}}","confidence":"embedded","approximations":[],"unsupported":[],"hasDistortion":{{embedded.ToString().ToLowerInvariant()}},"hasCa":false,"hasVignetting":{{embedded.ToString().ToLowerInvariant()}}}""");
            var resolution = LensProfileStore.ParseResolution(document.RootElement);
            Assert.Equal(embedded, resolution.Embedded);
            Assert.False(resolution.Imported);
            Assert.Equal(embedded, resolution.CoversAnyFamily);
            Assert.Empty(resolution.Samples);
            Assert.Contains(expected, resolution.Describe());
        }

        [Fact]
        public void EveryLensFieldIsDecodeOwned()
        {
            var baseline = new AdjustmentState();
            Assert.True(RenderEngine.DecodeInputsChanged(baseline, new AdjustmentState { LensProfile = "lcp1:" + Digest }));
            Assert.True(RenderEngine.DecodeInputsChanged(baseline, new AdjustmentState { LensCorrectionDistortion = 50 }));
            Assert.True(RenderEngine.DecodeInputsChanged(baseline, new AdjustmentState { LensCorrectionCa = 50 }));
            Assert.True(RenderEngine.DecodeInputsChanged(baseline, new AdjustmentState { LensCorrectionVignetting = 50 }));
            Assert.True(RenderEngine.DecodeInputsChanged(baseline, new AdjustmentState { LensProfileEnable = ToggleMode.Off }));
            Assert.False(RenderEngine.DecodeInputsChanged(baseline, new AdjustmentState { Exposure = 1 }));

            // The decode model keeps the whole selection: strip only removes
            // per-tick chain stages.
            var stripped = RenderEngine.StripChainStages(new AdjustmentState
            {
                LensProfile = "lcp1-ack:" + Digest, LensCorrectionCa = 40, Exposure = 2,
            });
            Assert.Equal("lcp1-ack:" + Digest, stripped.LensProfile);
            Assert.Equal(40, stripped.LensCorrectionCa);
            Assert.Equal(0, stripped.Exposure);
        }
    }
}
