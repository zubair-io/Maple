using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ProfileIntentTests
    {
        [Theory]
        [InlineData(ProfileMode.Auto)]
        [InlineData(ProfileMode.Neutral)]
        public void DecodeAndExportKeepTheSidecarProfile(ProfileMode profile)
        {
            var dir = Path.Combine(Path.GetTempPath(), "maple-profile-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                var raw = Path.Combine(dir, "photo.dng");
                SidecarStore.Save(raw, new XmpSidecarDocument
                {
                    Adjustments = new AdjustmentState { Profile = profile, Exposure = 1.5 },
                });
                var loaded = SidecarStore.Load(raw)!;
                Assert.Contains($"papp:Profile=\"{profile}\"", File.ReadAllText(SidecarStore.SidecarPathFor(raw)));
                Assert.Equal(profile, loaded.Adjustments.Profile);
                var decode = RenderEngine.StripChainStages(loaded.Adjustments);
                Assert.Equal(profile, decode.Profile);
                Assert.Equal(0, decode.Exposure);
                // The full model is the export input; stripping decode-only
                // stages must never mutate its exposure or render intent.
                Assert.Equal(1.5, loaded.Adjustments.Exposure);
                Assert.Equal(profile, XmpParser.Parse(XmpWriter.Serialize(loaded))!.Adjustments.Profile);
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }

        [Fact]
        public void ProfileChangesInEitherDirectionInvalidateTheDecodedBase()
        {
            var auto = new AdjustmentState();
            var neutral = new AdjustmentState { Profile = ProfileMode.Neutral };
            Assert.True(RenderEngine.DecodeInputsChanged(auto, neutral));
            Assert.True(RenderEngine.DecodeInputsChanged(neutral, auto));
            Assert.False(RenderEngine.DecodeInputsChanged(auto, auto.Clone()));
            Assert.False(RenderEngine.DecodeInputsChanged(auto, new AdjustmentState { Exposure = 1 }));
        }

        /// <summary>Capture sharpening (#3414) runs inside the decode, so BOTH
        /// of its fields have to invalidate the decoded base and BOTH have to
        /// survive the chain strip — otherwise the two Detail sliders would
        /// write the sidecar and never change a pixel on screen.</summary>
        [Fact]
        public void CaptureSharpeningIsDecodeOwnedInBothFields()
        {
            var baseline = new AdjustmentState();
            var amount = new AdjustmentState { CaptureSharpeningAmount = 60 };
            var sigma = new AdjustmentState { CaptureSharpeningSigma = 0.8 };

            Assert.True(RenderEngine.DecodeInputsChanged(baseline, amount));
            Assert.True(RenderEngine.DecodeInputsChanged(amount, baseline));
            Assert.True(RenderEngine.DecodeInputsChanged(baseline, sigma));
            Assert.True(RenderEngine.DecodeInputsChanged(sigma, baseline));

            // StripChainStages zeroes the GPU-chain sliders and KEEPS the
            // decode-owned ones — the decode is what applies them.
            var stripped = RenderEngine.StripChainStages(
                new AdjustmentState
                {
                    CaptureSharpeningAmount = 60,
                    CaptureSharpeningSigma = 0.8,
                    SharpenAmount = 120,
                });
            Assert.Equal(60, stripped.CaptureSharpeningAmount);
            Assert.Equal(0.8, stripped.CaptureSharpeningSigma);
            Assert.Equal(0, stripped.SharpenAmount);
        }

        [Theory]
        [InlineData("", ProfileMode.Auto)]
        [InlineData("papp:Look=\"Default\"", ProfileMode.Auto)]
        [InlineData("papp:Look=\"Neutral\"", ProfileMode.Neutral)]
        [InlineData("papp:Profile=\"AcrMatch\"", ProfileMode.Auto)]
        public void ResavingLegacySidecarsMakesExistingIntentExplicit(string attrs, ProfileMode expected)
        {
            var xml = $"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" {attrs}/></rdf:RDF></x:xmpmeta>";
            var parsed = XmpParser.Parse(xml)!;
            Assert.Equal(expected, parsed.Adjustments.Profile);
            var saved = XmpWriter.Serialize(parsed);
            Assert.Contains($"papp:Profile=\"{expected}\"", saved);
            Assert.Equal(expected, XmpParser.Parse(saved)!.Adjustments.Profile);
        }
    }
}
