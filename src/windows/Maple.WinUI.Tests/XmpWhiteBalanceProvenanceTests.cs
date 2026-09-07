// XmpWhiteBalanceProvenanceTests — the white-balance name + provenance
// block (#2434) on the Windows reader/writer: `crs:WhiteBalance`,
// `papp:WbSource`, `papp:WbSampleX`, `papp:WbSampleY`,
// `papp:WbAlgorithmVersion`.
//
// The cases mirror raw-core's `xmp/tests.rs` ("White-balance provenance")
// — the same Sampled pair (0.25, 0.75, version 1), the same gating rules,
// the same unknown-label tolerance — plus the bug this block was modeled
// to fix: before it, the five attributes rode through passthrough, so a
// sidecar sampled on Web/Apple kept `WbSource="Sampled"` and its stale
// sample point after any Windows edit of the pair.

using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpWhiteBalanceProvenanceTests
    {
        private static readonly string[] ProvenanceKeys =
        {
            "crs:WhiteBalance", "papp:WbSource", "papp:WbSampleX", "papp:WbSampleY", "papp:WbAlgorithmVersion",
        };

        /// <summary>Maple-authored: the `papp:` namespace is declared.</summary>
        private static string MapleSidecar(string attrs) => Sidecar(attrs, maple: true);

        /// <summary>ACR-shaped: `crs:` only, no Maple namespace anywhere.</summary>
        private static string AcrSidecar(string attrs) => Sidecar(attrs, maple: false);

        private static string Sidecar(string attrs, bool maple) => string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            maple ? "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"" : "",
            $"      {attrs}",
            "      crs:HasSettings=\"True\"/>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        private static XmpSidecarDocument ParseOrFail(string xml)
        {
            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);
            return doc!;
        }

        private static AdjustmentState Sampled() => new()
        {
            Temperature = 5200,
            Tint = -14.5,
            WbSource = WbSource.Sampled,
            WbSampleX = 0.25,
            WbSampleY = 0.75,
            WbAlgorithmVersion = 1,
        };

        [Fact]
        public void DefaultDocumentOmitsEveryProvenanceAttribute()
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument());

            foreach (var key in ProvenanceKeys) Assert.DoesNotContain(key, xml);
        }

        [Fact]
        public void SampledPairWritesTheCanonicalAttributesAndRoundTrips()
        {
            var doc = new XmpSidecarDocument { Adjustments = Sampled() };

            var xml = XmpWriter.Serialize(doc);

            // The same four literals raw-core's serializer produces for this
            // model (`wb_provenance_omitted_at_default_and_round_trips_a_sampled_pair`).
            Assert.Contains("papp:WbSource=\"Sampled\"", xml);
            Assert.Contains("papp:WbSampleX=\"0.25\"", xml);
            Assert.Contains("papp:WbSampleY=\"0.75\"", xml);
            Assert.Contains("papp:WbAlgorithmVersion=\"1\"", xml);
            Assert.DoesNotContain("crs:WhiteBalance", xml);

            var parsed = ParseOrFail(xml).Adjustments;
            Assert.Equal(WbSource.Sampled, parsed.WbSource);
            Assert.Equal((0.25, 0.75), (parsed.WbSampleX, parsed.WbSampleY));
            Assert.Equal(1, parsed.WbAlgorithmVersion);
            Assert.Equal(WhiteBalancePresets.Custom, parsed.WhiteBalancePreset);
        }

        /// <summary>
        /// Hand-traced golden in the style of
        /// `XmpCanonicalEnvelopeTests.MinimalDocumentMatchesHandComputedGolden`:
        /// the provenance attributes sit in the `papp:` block in canonical
        /// (namespace priority, then ordinal name) order — raw-core's
        /// fragment lists them Source / X / Y / Version, but every
        /// whole-document writer sorts, and Windows is no exception.
        /// </summary>
        [Fact]
        public void SampledDocumentMatchesHandComputedGolden()
        {
            var doc = new XmpSidecarDocument { Adjustments = Sampled() };

            var expected = string.Join("\n", new[]
            {
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
                "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
                "      crs:HasSettings=\"True\"",
                "      crs:ProcessVersion=\"11.0\"",
                "      crs:Temperature=\"5200\"",
                "      crs:Tint=\"-14.5\"",
                "      crs:Version=\"11.0\"",
                "      papp:Profile=\"Auto\"",
                "      papp:WbAlgorithmVersion=\"1\"",
                "      papp:WbSampleX=\"0.25\"",
                "      papp:WbSampleY=\"0.75\"",
                "      papp:WbScaleVersion=\"5\"",
                "      papp:WbSource=\"Sampled\"/>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            Assert.Equal(expected, XmpWriter.Serialize(doc));
        }

        [Fact]
        public void ProvenanceIsConsumedNotPassthrough()
        {
            var doc = ParseOrFail(MapleSidecar(
                "crs:Temperature=\"5200\" crs:WhiteBalance=\"Shade\" papp:WbSource=\"Sampled\" " +
                "papp:WbSampleX=\"0.25\" papp:WbSampleY=\"0.75\" papp:WbAlgorithmVersion=\"1\""));

            Assert.Empty(doc.PassthroughAttributes);
            Assert.Equal(WhiteBalancePresets.Shade, doc.Adjustments.WhiteBalancePreset);
            Assert.Equal(WbSource.Sampled, doc.Adjustments.WbSource);
            Assert.Equal(0.25, doc.Adjustments.WbSampleX);
            Assert.Equal(0.75, doc.Adjustments.WbSampleY);
            Assert.Equal(1, doc.Adjustments.WbAlgorithmVersion);
        }

        /// <summary>The bug: a sidecar sampled on another host, then given a
        /// manual temperature on Windows, must not re-save the stale sample.</summary>
        [Fact]
        public void ManualEditAfterAForeignSampleDropsTheStaleProvenance()
        {
            var doc = ParseOrFail(MapleSidecar(
                "crs:Temperature=\"5200\" crs:Tint=\"-14.5\" crs:WhiteBalance=\"Daylight\" papp:WbSource=\"Sampled\" " +
                "papp:WbSampleX=\"0.25\" papp:WbSampleY=\"0.75\" papp:WbAlgorithmVersion=\"1\""));

            WhiteBalanceProvenance.SetManualTemperature(doc.Adjustments, 5600);
            var xml = XmpWriter.Serialize(doc);

            Assert.Contains("crs:Temperature=\"5600\"", xml);
            Assert.Contains("papp:WbSource=\"Manual\"", xml);
            Assert.DoesNotContain("Sampled", xml);
            Assert.DoesNotContain("papp:WbSampleX", xml);
            Assert.DoesNotContain("papp:WbSampleY", xml);
            Assert.DoesNotContain("papp:WbAlgorithmVersion", xml);
            Assert.DoesNotContain("crs:WhiteBalance", xml);
        }

        [Fact]
        public void AutoStampWritesNameSourceAndVersion()
        {
            var doc = ParseOrFail(MapleSidecar(
                "crs:Temperature=\"5200\" papp:WbSource=\"Sampled\" papp:WbSampleX=\"0.25\" " +
                "papp:WbSampleY=\"0.75\" papp:WbAlgorithmVersion=\"1\""));

            doc.Adjustments.Temperature = 4900;
            doc.Adjustments.Tint = 3;
            WhiteBalanceProvenance.MarkAuto(doc.Adjustments);
            var xml = XmpWriter.Serialize(doc);

            Assert.Contains("crs:WhiteBalance=\"Auto\"", xml);
            Assert.Contains("papp:WbSource=\"Auto\"", xml);
            Assert.Contains("papp:WbAlgorithmVersion=\"1\"", xml);
            Assert.DoesNotContain("papp:WbSampleX", xml);
            Assert.DoesNotContain("papp:WbSampleY", xml);
            Assert.DoesNotContain("Sampled", xml);
        }

        [Fact]
        public void SamplePointTravelsOnlyWithADerivedSampledSource()
        {
            // A Preset pair never carries coordinates, even stale ones.
            var preset = new XmpSidecarDocument
            {
                Adjustments = new AdjustmentState
                {
                    WhiteBalancePreset = WhiteBalancePresets.Daylight,
                    WbSource = WbSource.Preset, WbSampleX = 0.4, WbSampleY = 0.6,
                },
            };
            var presetXml = XmpWriter.Serialize(preset);
            Assert.Contains("crs:WhiteBalance=\"Daylight\"", presetXml);
            Assert.Contains("papp:WbSource=\"Preset\"", presetXml);
            Assert.DoesNotContain("papp:WbSampleX", presetXml);
            Assert.DoesNotContain("papp:WbSampleY", presetXml);
            Assert.DoesNotContain("papp:WbAlgorithmVersion", presetXml);

            // Auto: version, no point.
            var auto = new XmpSidecarDocument
            {
                Adjustments = new AdjustmentState { WbSource = WbSource.Auto, WbAlgorithmVersion = 1 },
            };
            var autoXml = XmpWriter.Serialize(auto);
            Assert.Contains("papp:WbSource=\"Auto\"", autoXml);
            Assert.Contains("papp:WbAlgorithmVersion=\"1\"", autoXml);
            Assert.DoesNotContain("papp:WbSampleX", autoXml);

            // A Sampled label with no version is what a pasted look carries
            // (the source copies; the point and version do not): writing
            // `0,0` there would claim a sample that never happened (#3309).
            var pasted = new XmpSidecarDocument
            {
                Adjustments = new AdjustmentState { WbSource = WbSource.Sampled, WbSampleX = 0.4, WbSampleY = 0.6 },
            };
            var pastedXml = XmpWriter.Serialize(pasted);
            Assert.Contains("papp:WbSource=\"Sampled\"", pastedXml);
            Assert.DoesNotContain("papp:WbSampleX", pastedXml);
            Assert.DoesNotContain("papp:WbAlgorithmVersion", pastedXml);

            // Nor does a version stranded on a source that cannot derive one.
            var manual = new XmpSidecarDocument
            {
                Adjustments = new AdjustmentState { WbSource = WbSource.Manual, WbAlgorithmVersion = 1 },
            };
            Assert.DoesNotContain("papp:WbAlgorithmVersion", XmpWriter.Serialize(manual));
        }

        [Theory]
        [InlineData("AsShot", WbSource.AsShot)]
        [InlineData("Auto", WbSource.Auto)]
        [InlineData("Preset", WbSource.Preset)]
        [InlineData("Sampled", WbSource.Sampled)]
        [InlineData("Manual", WbSource.Manual)]
        [InlineData("manual", WbSource.Manual)]
        public void SourceParsesEveryVariant(string wire, WbSource expected)
        {
            var doc = ParseOrFail(MapleSidecar($"papp:WbSource=\"{wire}\""));

            Assert.Equal(expected, doc.Adjustments.WbSource);
        }

        [Fact]
        public void UnknownSourceLabelKeepsTheDefaultAndTheAdjustmentsAlongside()
        {
            var doc = ParseOrFail(MapleSidecar("papp:WbSource=\"Eyeballed\" crs:Exposure2012=\"1.25\""));

            Assert.Equal(WbSource.AsShot, doc.Adjustments.WbSource);
            Assert.Equal(1.25, doc.Adjustments.Exposure);
            Assert.Empty(doc.PassthroughAttributes);
        }

        [Fact]
        public void UnknownPresetNameReadsAsCustom()
        {
            var doc = ParseOrFail(MapleSidecar("crs:WhiteBalance=\"Moonlight\""));

            Assert.Equal(WhiteBalancePresets.Custom, doc.Adjustments.WhiteBalancePreset);
            Assert.DoesNotContain("crs:WhiteBalance", XmpWriter.Serialize(doc));
        }

        /// <summary>A name-only foreign sidecar resolves the pair from the
        /// same table as raw-core and the pickers, and reads as Preset.</summary>
        [Fact]
        public void NamedIlluminantResolvesItsPairWhenNoExplicitPairIsAuthored()
        {
            var doc = ParseOrFail(AcrSidecar("crs:WhiteBalance=\"Daylight\""));

            Assert.Equal(WhiteBalancePresets.Daylight, doc.Adjustments.WhiteBalancePreset);
            Assert.Equal((5500.0, 10.0), (doc.Adjustments.Temperature, doc.Adjustments.Tint));
            Assert.Equal(WbSource.Preset, doc.Adjustments.WbSource);
            Assert.Equal(5, doc.WbScaleVersion);
        }

        [Fact]
        public void ExplicitPairComponentWinsOverTheNamedIlluminant()
        {
            var doc = ParseOrFail(AcrSidecar("crs:Temperature=\"4800\" crs:WhiteBalance=\"Daylight\""));

            Assert.Equal(4800, doc.Adjustments.Temperature);
            Assert.Equal(10, doc.Adjustments.Tint);
            Assert.Equal(WbSource.Preset, doc.Adjustments.WbSource);
        }

        [Fact]
        public void ExplicitSourceWinsOverThePresetInference()
        {
            var doc = ParseOrFail(MapleSidecar("crs:WhiteBalance=\"Daylight\" papp:WbSource=\"Manual\""));

            Assert.Equal(WbSource.Manual, doc.Adjustments.WbSource);
        }

        /// <summary>A foreign authored pair with a Custom (or absent) name is
        /// shown as Manual; a Maple-authored document keeps legacy AsShot
        /// omission semantics. The label changes, the pair never does.</summary>
        [Fact]
        public void ForeignAuthoredPairWithoutANameReadsAsManual()
        {
            var custom = ParseOrFail(AcrSidecar("crs:Temperature=\"5000\" crs:WhiteBalance=\"Custom\""));
            Assert.Equal(WbSource.Manual, custom.Adjustments.WbSource);
            Assert.Equal(5000, custom.Adjustments.Temperature);

            var unnamed = ParseOrFail(AcrSidecar("crs:Tint=\"12\""));
            Assert.Equal(WbSource.Manual, unnamed.Adjustments.WbSource);

            var maple = ParseOrFail(MapleSidecar("crs:Temperature=\"5000\""));
            Assert.Equal(WbSource.AsShot, maple.Adjustments.WbSource);

            var unauthored = ParseOrFail(AcrSidecar("crs:Exposure2012=\"0.5\""));
            Assert.Equal(WbSource.AsShot, unauthored.Adjustments.WbSource);
        }

        [Fact]
        public void ProvenanceSurvivesAnUnrelatedEditRoundTrip()
        {
            var doc = ParseOrFail(MapleSidecar(
                "crs:Temperature=\"5200\" crs:WhiteBalance=\"Shade\" papp:WbSource=\"Sampled\" " +
                "papp:WbSampleX=\"0.25\" papp:WbSampleY=\"0.75\" papp:WbAlgorithmVersion=\"1\""));

            doc.Adjustments.Exposure = 0.7;
            var resaved = ParseOrFail(XmpWriter.Serialize(doc));

            Assert.Equal(WhiteBalancePresets.Shade, resaved.Adjustments.WhiteBalancePreset);
            Assert.Equal(WbSource.Sampled, resaved.Adjustments.WbSource);
            Assert.Equal((0.25, 0.75), (resaved.Adjustments.WbSampleX, resaved.Adjustments.WbSampleY));
            Assert.Equal(1, resaved.Adjustments.WbAlgorithmVersion);
            Assert.Equal(0.7, resaved.Adjustments.Exposure);
        }
    }
}
