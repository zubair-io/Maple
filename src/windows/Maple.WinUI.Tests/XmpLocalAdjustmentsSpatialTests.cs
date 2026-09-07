// XmpLocalAdjustmentsSpatialTests — the six per-mask SPATIAL controls'
// sidecar contract (#3407): Adobe's ±1 fraction scale, omit-on-default, and
// `crs:CorrectionAmount` scaling.
//
// A sibling of `XmpLocalAdjustmentsTests` so that file stays inside the
// 570-line headroom threshold (#2311) — the same split the Rust side made
// into `tests_local_adjustments_spatial.rs` and the TypeScript side into
// `local-adjustments-spatial.spec.ts`. The shared fixture helpers
// (`Sidecar`, `GradientCorrection`, `FullFrameGradient`, `CanonicalIndent`)
// stay owned by that class and are reached here as `internal` statics — one
// fixture, two files.

using System;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpLocalAdjustmentsSpatialTests
    {
        private const string CanonicalIndent = XmpLocalAdjustmentsTests.CanonicalIndent;
        private const string FullFrameGradient = XmpLocalAdjustmentsTests.FullFrameGradient;

        private static string Sidecar(string children) =>
            XmpLocalAdjustmentsTests.Sidecar(children);

        private static string GradientCorrection(string descriptionAttrs, string maskLeaf) =>
            XmpLocalAdjustmentsTests.GradientCorrection(descriptionAttrs, maskLeaf);

        private static readonly LocalAdjustment LinearLayer = XmpLocalAdjustmentsTests.LinearLayer;


        /// <summary>
        /// A Lightroom-authored correction carrying the six #3407 keys parses
        /// into Maple's ±100 sliders, and re-serializing reproduces the SAME
        /// attribute text byte-for-byte — the ticket's acceptance bar, and the
        /// C# half of raw-core's
        /// `a_lightroom_authored_spatial_correction_round_trips_byte_for_byte`.
        /// Adobe stores these as ±1 fractions, so crs:LocalClarity2012="0.35"
        /// is a Clarity of +35 and must come back out as "0.35", never "35"
        /// or "0.35000001".
        /// </summary>
        [Fact]
        public void LightroomAuthoredSpatialCorrectionRoundTripsByteForByte()
        {
            var block = string.Join("\n", new[]
            {
                "      <crs:CircularGradientBasedCorrections>",
                "        <rdf:Seq>",
                "          <rdf:li>",
                "            <rdf:Description",
                "              crs:What=\"Correction\"",
                "              crs:CorrectionAmount=\"1\"",
                "              crs:CorrectionActive=\"True\"",
                "              crs:LocalTexture=\"0.2\"",
                "              crs:LocalClarity2012=\"0.35\"",
                "              crs:LocalDehaze=\"-0.4\"",
                "              crs:LocalSharpness=\"0.55\"",
                "              crs:LocalLuminanceNoise=\"0.3\"",
                "              crs:LocalDefringe=\"0.65\">",
                "              <crs:CorrectionMasks>",
                "                <rdf:Seq>",
                "                  <rdf:li",
                "                    crs:What=\"Mask/CircularGradient\"",
                "                    crs:MaskValue=\"1\"",
                "                    crs:Top=\"0.25\" crs:Left=\"0.25\" crs:Bottom=\"0.75\" crs:Right=\"0.75\"",
                "                    crs:Angle=\"0\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
                "                    crs:Feather=\"50\" crs:Flipped=\"False\"/>",
                "                </rdf:Seq>",
                "              </crs:CorrectionMasks>",
                "            </rdf:Description>",
                "          </rdf:li>",
                "        </rdf:Seq>",
                "      </crs:CircularGradientBasedCorrections>",
            });
            var doc = XmpParser.Parse(Sidecar(block));
            var a = Assert.Single(doc!.Adjustments.LocalAdjustments).Adjustments;
            // The ×100 lift out of Adobe's fraction scale is a float multiply,
            // so these are compared to within noise (0.55 × 100 is
            // 55.000000000000007); the byte-for-byte assertion below is what
            // pins the WIRE exactly.
            var expected = new (double? Got, double Want)[]
            {
                (a.Texture, 20), (a.Clarity, 35), (a.Dehaze, -40),
                (a.Sharpness, 55), (a.LuminanceNoise, 30), (a.Defringe, 65),
            };
            foreach (var (got, want) in expected)
            {
                Assert.NotNull(got);
                Assert.True(Math.Abs(got!.Value - want) < 1e-9, $"{got} vs {want}");
            }
            Assert.Equal(block, XmpLocalAdjustments.Serialize(doc.Adjustments.LocalAdjustments, CanonicalIndent));
        }

        /// <summary>
        /// Omit-on-default: a layer that sets none of the six emits none of
        /// the six keys, so an unedited correction stays byte-identical on
        /// re-save and a null stays distinct from a 0.
        /// </summary>
        [Fact]
        public void UnsetSpatialControlsEmitNoAttributes()
        {
            var layer = LinearLayer with { Adjustments = new PartialAdjustments { Exposure = 0.25 } };
            var block = XmpLocalAdjustments.Serialize(new[] { layer }, CanonicalIndent);
            foreach (var key in new[]
            {
                "crs:LocalTexture", "crs:LocalClarity2012", "crs:LocalDehaze",
                "crs:LocalSharpness", "crs:LocalLuminanceNoise", "crs:LocalDefringe",
            })
            {
                Assert.DoesNotContain(key, block);
            }
            var doc = XmpParser.Parse(Sidecar(block));
            Assert.True(Assert.Single(doc!.Adjustments.LocalAdjustments).Adjustments.SpatialIsEmpty);
        }

        /// <summary>
        /// An explicit 0 is a real value, not silence: the writer emits the
        /// key and the reader brings it back as 0 rather than null.
        /// </summary>
        [Fact]
        public void ExplicitZeroSpatialControlsSurviveTheRoundTrip()
        {
            var layer = LinearLayer with
            {
                Adjustments = new PartialAdjustments
                {
                    Texture = 0,
                    Clarity = 0,
                    Dehaze = 0,
                    Sharpness = 0,
                    LuminanceNoise = 0,
                    Defringe = 0,
                },
            };
            var block = XmpLocalAdjustments.Serialize(new[] { layer }, CanonicalIndent);
            Assert.Contains("crs:LocalTexture=\"0\"", block);
            Assert.Contains("crs:LocalDefringe=\"0\"", block);
            var doc = XmpParser.Parse(Sidecar(block));
            var parsed = Assert.Single(doc!.Adjustments.LocalAdjustments);
            Assert.Equal(layer, parsed);
            Assert.False(parsed.Adjustments.SpatialIsEmpty);
        }

        /// <summary>
        /// `crs:CorrectionAmount` scales the six exactly as it scales every
        /// other stored delta — Adobe's own Amount semantics.
        /// </summary>
        [Fact]
        public void CorrectionAmountScalesTheSpatialControls()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:What=\"Correction\" crs:CorrectionAmount=\"0.5\" crs:LocalClarity2012=\"0.4\"",
                FullFrameGradient)));
            var clarity = Assert.Single(doc!.Adjustments.LocalAdjustments).Adjustments.Clarity;
            Assert.NotNull(clarity);
            Assert.True(Math.Abs(clarity!.Value - 20) < 1e-9, $"{clarity}");
        }
    }
}
