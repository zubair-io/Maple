// XmpWbScaleVersionTests — WB slider-scale versioning (#1780/#1875/#1893/
// #1894/#2670).
//
// Mirrors the Rust tests in `raw-core/src/xmp/tests_wb_scale.rs`, the web
// tests in `maple-common/src/lib/xmp/wb-scale-version.spec.ts`, and the
// Swift tests in `WbScaleVersionTests.swift`:
//
//  - explicit `papp:WbScaleVersion` stamp wins;
//  - a stamp outside 1..5 is treated as absent (Swift's `(1...5).contains`
//    guard) rather than propagated into the conversion;
//  - a Maple-authored sidecar (papp namespace present) with no stamp is
//    version 1 (pre-#1756 scale);
//  - a V2/V3/V4 stamp load-normalizes: the authored `(temperature, tint)`
//    pair converts JOINTLY through physical chromaticity
//    (`XmpWbScale.AuthoredPairToV5`, ported from raw-core's
//    `authored_pair_to_v5`), and the STORED version clamps to {1, 5} —
//    never 2, 3, or 4;
//  - V1 deliberately does NOT load-normalize (raw-core converts it at
//    develop time, using the image's calibration frame).
//
// Expected converted values are pinned against the same Rust reference
// vectors the Swift and TypeScript suites use (`authored_pair_to_v5`),
// copied from `WbScaleVersionTests.swift`, at the same tolerances (0.05 K /
// 0.005 tint) since the Robertson/Hernández-Andrés math is transcendental
// and floating-point paths differ slightly across languages.
//
// Before #2670 this suite characterized Windows's OWN (wrong) behavior —
// see git history for the "KnownGap_*" versions of these tests.

using System;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpWbScaleVersionTests
    {
        private static string MapleSidecar(string attrs) => string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
            $"      {attrs}",
            "      crs:HasSettings=\"True\">",
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        /// <summary>ACR-shaped sidecar: `crs:` only, no Maple namespace anywhere.</summary>
        private static string AcrSidecar(string attrs) => string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            $"      {attrs}",
            "      crs:HasSettings=\"True\">",
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        /// <summary>
        /// xUnit's `Assert.Equal(double, double, int precision)` rounds
        /// both values to N decimal places, which doesn't express "within
        /// 0.05 K" cleanly. This asserts an absolute-difference tolerance
        /// instead, the same check the TypeScript suite's `toBeCloseTo`
        /// performs.
        /// </summary>
        private static void AssertClose(double expected, double actual, double tolerance)
        {
            var diff = Math.Abs(expected - actual);
            Assert.True(diff <= tolerance,
                $"expected {actual} to be within {tolerance} of {expected}, but differed by {diff}");
        }

        [Fact]
        public void MapleAuthoredWithoutStampParsesAsVersion1()
        {
            var doc = XmpParser.Parse(MapleSidecar("crs:Temperature=\"6282\" crs:Tint=\"-44\""));
            Assert.NotNull(doc);
            Assert.Equal(1, doc!.WbScaleVersion);
            Assert.Equal(6282, doc.Adjustments.Temperature, precision: 9);
            Assert.Equal(-44, doc.Adjustments.Tint, precision: 9);
        }

        [Fact]
        public void AcrAuthoredWithoutPappParsesAsVersion5()
        {
            // ACR's crs:Temperature/crs:Tint are already expressed in the
            // Robertson (V5, #1894) convention — pass through unconverted.
            var doc = XmpParser.Parse(AcrSidecar("crs:Temperature=\"5500\" crs:Tint=\"10\""));
            Assert.NotNull(doc);
            Assert.Equal(5, doc!.WbScaleVersion);
            Assert.Equal(5500, doc.Adjustments.Temperature, precision: 9);
            Assert.Equal(10, doc.Adjustments.Tint, precision: 9);
        }

        [Fact]
        public void ExplicitStampWinsOverHeuristicAndConvertsJointly()
        {
            // A V2 stamp beats the V1 authorship heuristic, then
            // load-normalizes to 5. No tint was authored (absent-tint
            // convention: 0), but the pair conversion is JOINT (#1894) — an
            // authored temperature alone still moves both components.
            // Pinned against `authored_pair_to_v5(5700, 0, V2)`.
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5700\" papp:WbScaleVersion=\"2\""));
            Assert.NotNull(doc);
            Assert.Equal(5, doc!.WbScaleVersion);
            AssertClose(5697.007, doc.Adjustments.Temperature, 0.05);
            AssertClose(11.083624, doc.Adjustments.Tint, 0.005);
        }

        [Fact]
        public void V2AuthoredPairConvertsJointlyIntoV5OnLoad()
        {
            // The V2 scale's tint axis was inverted vs ACR at the legacy
            // 1e-4 magnitude, evaluated on the Hernández-Andrés locus.
            // Pinned against `authored_pair_to_v5(5700, 50, V2)`.
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5700\" crs:Tint=\"50\" papp:WbScaleVersion=\"2\""));
            Assert.NotNull(doc);
            Assert.Equal(5, doc!.WbScaleVersion);
            AssertClose(5696.3936, doc.Adjustments.Temperature, 0.05);
            AssertClose(-3.9181564, doc.Adjustments.Tint, 0.005);
        }

        [Fact]
        public void V3AuthoredPairConvertsJointlyIntoV5OnLoad()
        {
            // V3 is the ACR direction at the legacy 1e-4 magnitude, legacy
            // locus. Pinned against `authored_pair_to_v5(5520, -144, V3)`.
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5520\" crs:Tint=\"-144\" papp:WbScaleVersion=\"3\""));
            Assert.NotNull(doc);
            Assert.Equal(5, doc!.WbScaleVersion);
            AssertClose(5526.068, doc.Adjustments.Temperature, 0.05);
            AssertClose(-32.580647, doc.Adjustments.Tint, 0.005);
        }

        [Fact]
        public void V4AuthoredPairConvertsJointlyIntoV5OnLoad()
        {
            // V4 shares V5's tint magnitude/axis but evaluated on the
            // legacy (Hernández-Andrés) locus rather than Robertson — never
            // shipped in a release, but a dev-window sidecar must still
            // load-normalize. Pinned against
            // `authored_pair_to_v5(5520, -53, V4)`.
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5520\" crs:Tint=\"-53\" papp:WbScaleVersion=\"4\""));
            Assert.NotNull(doc);
            Assert.Equal(5, doc!.WbScaleVersion);
            AssertClose(5526.5674, doc.Adjustments.Temperature, 0.05);
            AssertClose(-42.379494, doc.Adjustments.Tint, 0.005);
        }

        [Fact]
        public void V5StampPassesThroughUnconverted()
        {
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5520\" crs:Tint=\"-53\" papp:WbScaleVersion=\"5\""));
            Assert.NotNull(doc);
            Assert.Equal(5, doc!.WbScaleVersion);
            Assert.Equal(5520, doc.Adjustments.Temperature, precision: 9);
            Assert.Equal(-53, doc.Adjustments.Tint, precision: 9);
        }

        [Theory]
        [InlineData("0")]
        [InlineData("6")]
        [InlineData("9")]
        [InlineData("-1")]
        public void OutOfRangeStampIsTreatedAsAbsent(string stamp)
        {
            // Mirrors Swift's `(1...5).contains(v)` guard: an out-of-range
            // stamp must not be stored or fed into the conversion switch —
            // it falls back to the authorship heuristic (papp namespace +
            // explicit WB present here, so version 1, unconverted).
            var doc = XmpParser.Parse(
                MapleSidecar($"crs:Temperature=\"6282\" crs:Tint=\"-44\" papp:WbScaleVersion=\"{stamp}\""));
            Assert.NotNull(doc);
            Assert.Equal(1, doc!.WbScaleVersion);
            Assert.Equal(6282, doc.Adjustments.Temperature, precision: 9);
            Assert.Equal(-44, doc.Adjustments.Tint, precision: 9);
        }

        [Fact]
        public void ResaveOfALegacyStampedDocumentUpgradesTheStampNotJustTheNumbers()
        {
            // A re-save must never emit "2" — Swift/TS never write anything
            // but {1, 5}, and re-emitting the raw legacy stamp over
            // already-converted V5 numbers would corrupt the next load.
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5700\" crs:Tint=\"50\" papp:WbScaleVersion=\"2\""));
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            Assert.Contains("papp:WbScaleVersion=\"5\"", resaved);
            Assert.DoesNotContain("papp:WbScaleVersion=\"2\"", resaved);

            var reparsed = XmpParser.Parse(resaved);
            Assert.NotNull(reparsed);
            Assert.Equal(5, reparsed!.WbScaleVersion);
            // The writer's 2-decimal wire codec (`XmpSchema.FormatNumber`)
            // quantizes the already-converted value, so the round trip
            // isn't bit-exact — within 0.01 confirms it's the SAME
            // converted number, not a re-conversion or the raw legacy one.
            AssertClose(doc!.Adjustments.Temperature, reparsed.Adjustments.Temperature, 0.01);
            AssertClose(doc.Adjustments.Tint, reparsed.Adjustments.Tint, 0.01);
        }

        [Fact]
        public void StampOneRoundTripsUnconvertedOnEveryPlatform()
        {
            // Version 1 deliberately does NOT load-normalize: its
            // conversion needs the image's calibration frame, so raw-core
            // converts it at develop time, and the sidecar round-trips as
            // V1 on every platform.
            var doc = XmpParser.Parse(
                MapleSidecar("crs:Temperature=\"5900\" crs:Tint=\"20\" papp:WbScaleVersion=\"1\""));
            Assert.NotNull(doc);

            Assert.Equal(1, doc!.WbScaleVersion);
            Assert.Equal(5900, doc.Adjustments.Temperature, precision: 9);
            Assert.Equal(20, doc.Adjustments.Tint, precision: 9);

            var resaved = XmpWriter.Serialize(doc);
            Assert.Contains("papp:WbScaleVersion=\"1\"", resaved);
        }
    }
}
