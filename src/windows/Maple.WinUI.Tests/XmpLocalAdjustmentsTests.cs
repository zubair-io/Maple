// XmpLocalAdjustmentsTests — nested-element XMP I/O for local adjustments
// (#358): the canonical `crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections` containers.
//
// `CanonicalBlock` below is the cross-language parity artifact: the same
// literal appears in the Rust suite (`raw-core/src/xmp/tests_local_adjustments.rs`),
// the Swift suite (`LocalAdjustmentXMPTests.swift`) and the TypeScript suite
// (`local-adjustments.spec.ts`), and all four serializers must produce it
// byte-for-byte from the same two-layer model at the same indent.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpLocalAdjustmentsTests : IDisposable
    {
        private const string CanonicalIndent = "      ";

        /// <summary>The linear half of the shared fixture (`linear_layer()` in Rust).</summary>
        internal static readonly LocalAdjustment LinearLayer = new(
            new LinearMask(new MaskPoint(0.2, 0.3), new MaskPoint(0.8, 0.7), 0.4),
            new PartialAdjustments { Exposure = 0.5, Shadows = -20, Hue = -35 },
            new ColorRangeRefinement(55, 25, 0.02, 0.15, 0.95, 0.3));

        /// <summary>
        /// The radial half (`radial_layer()` in Rust). Binary-exact fractions
        /// so the wire form's center ± radii bounding box round-trips to
        /// bit-identical doubles; the angle uses the parser's own conversion.
        /// </summary>
        internal static readonly LocalAdjustment RadialLayer = new(
            new RadialMask(new MaskPoint(0.5, 0.375), new MaskPoint(0.25, 0.125), 45 * Math.PI / 180, 0.6, true),
            new PartialAdjustments { Contrast = 15, Vibrance = -10, Temperature = 200, Hue = 0 },
            new ColorRangeRefinement(210, 40, 0.1, 0, 1, 0));

        internal static readonly string CanonicalBlock = string.Join("\n", new[]
        {
            "      <crs:GradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              crs:LocalExposure2012=\"0.5\"",
            "              crs:LocalShadows2012=\"-20\"",
            "              crs:LocalHue=\"-0.35\"",
            "              papp:RangeKind=\"Color\"",
            "              papp:RangeHue=\"55\"",
            "              papp:RangeHueWidth=\"25\"",
            "              papp:RangeChromaMin=\"0.02\"",
            "              papp:RangeLMin=\"0.15\"",
            "              papp:RangeLMax=\"0.95\"",
            "              papp:RangeFeather=\"0.3\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/Gradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:ZeroX=\"0.2\" crs:ZeroY=\"0.3\"",
            "                    crs:FullX=\"0.8\" crs:FullY=\"0.7\"",
            "                    papp:LocalFeather=\"0.4\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:GradientBasedCorrections>",
            "      <crs:CircularGradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              crs:LocalContrast2012=\"15\"",
            "              papp:LocalVibrance=\"-10\"",
            "              crs:LocalTemperature=\"200\"",
            "              crs:LocalHue=\"0\"",
            "              papp:RangeKind=\"Color\"",
            "              papp:RangeHue=\"210\"",
            "              papp:RangeHueWidth=\"40\"",
            "              papp:RangeChromaMin=\"0.1\"",
            "              papp:RangeLMin=\"0\"",
            "              papp:RangeLMax=\"1\"",
            "              papp:RangeFeather=\"0\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/CircularGradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:Top=\"0.25\" crs:Left=\"0.25\" crs:Bottom=\"0.5\" crs:Right=\"0.75\"",
            "                    crs:Angle=\"45\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
            "                    crs:Feather=\"60\" crs:Flipped=\"True\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:CircularGradientBasedCorrections>",
        });

        private const string FullFrameGradient =
            "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroX=\"0\" crs:ZeroY=\"0\" crs:FullX=\"1\" crs:FullY=\"0\"/>";

        private readonly string _dir;

        public XmpLocalAdjustmentsTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-xmp-358-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            // Best-effort cleanup of a temp directory: nothing here may fail
            // the test run (Copilot review on #3258).
            try { Directory.Delete(_dir, recursive: true); }
            catch (Exception) { /* best-effort cleanup */ }
        }

        private static string Sidecar(string children) => string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
            "      crs:Version=\"11.0\">",
            children,
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        private static string GradientCorrection(string descriptionAttrs, string maskLeaf) => string.Join("\n", new[]
        {
            "      <crs:GradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            $"            <rdf:Description {descriptionAttrs}>",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            $"                  {maskLeaf}",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:GradientBasedCorrections>",
        });

        private static XmpSidecarDocument WithLayers(params LocalAdjustment[] layers)
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.LocalAdjustments.AddRange(layers);
            return doc;
        }

        // ── Cross-language parity ────────────────────────────────────────────

        [Fact]
        public void SerializesTheCanonicalBlockFromAHandBuiltModel()
        {
            Assert.Equal(CanonicalBlock,
                XmpLocalAdjustments.Serialize(new[] { LinearLayer, RadialLayer }, CanonicalIndent));
        }

        [Fact]
        public void ParsesTheCanonicalBlockIntoTheFixtureLayers()
        {
            var doc = XmpParser.Parse(Sidecar(CanonicalBlock));
            Assert.NotNull(doc);
            Assert.Equal(new[] { LinearLayer, RadialLayer }, doc!.Adjustments.LocalAdjustments);
        }

        [Fact]
        public void RoundTripsTheCanonicalBlockByteForByte()
        {
            var doc = XmpParser.Parse(Sidecar(CanonicalBlock));
            Assert.NotNull(doc);
            Assert.Equal(CanonicalBlock,
                XmpLocalAdjustments.Serialize(doc!.Adjustments.LocalAdjustments, CanonicalIndent));
        }

        // ── Whole-document behaviour ─────────────────────────────────────────

        [Fact]
        public void RidesTheModelNotThePassthroughBucketAndResavesAsAFixedPoint()
        {
            var original = XmpWriter.Serialize(WithLayers(LinearLayer, RadialLayer));
            Assert.Contains(CanonicalBlock, original);

            var parsed = XmpParser.Parse(original);
            Assert.NotNull(parsed);
            Assert.Empty(parsed!.PassthroughNodes);
            Assert.Equal(new[] { LinearLayer, RadialLayer }, parsed.Adjustments.LocalAdjustments);
            Assert.Equal(original, XmpWriter.Serialize(parsed));
        }

        [Fact]
        public void EmptyStackEmitsNothing()
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument());
            Assert.DoesNotContain("GradientBasedCorrections", xml);
            Assert.DoesNotContain("</rdf:Description>", xml);
            Assert.Equal("", XmpLocalAdjustments.Serialize(Array.Empty<LocalAdjustment>(), CanonicalIndent));
        }

        [Fact]
        public void InterleavedStackWritesTwoContiguousRunsLinearFirst()
        {
            var block = XmpLocalAdjustments.Serialize(new[] { RadialLayer, LinearLayer, RadialLayer }, CanonicalIndent);
            var gradient = block.IndexOf("<crs:GradientBasedCorrections>", StringComparison.Ordinal);
            var circular = block.IndexOf("<crs:CircularGradientBasedCorrections>", StringComparison.Ordinal);
            Assert.True(gradient >= 0);
            Assert.True(circular > gradient);
            Assert.Equal(2, block.Split("Mask/CircularGradient").Length - 1);
        }

        /// <summary>
        /// Keeps its slot relative to passthrough content on a
        /// read-modify-write (#2671), like the tone-curve blocks.
        /// </summary>
        [Fact]
        public void KeepsItsPositionRelativeToPassthroughNodes()
        {
            var children = string.Join("\n", new[]
            {
                "      <crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li crs:What=\"Correction\"/></rdf:Seq></crs:MaskGroupBasedCorrections>",
                CanonicalBlock,
            });
            var doc = XmpParser.Parse(Sidecar(children));
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);
            // The preserved node re-emits with its in-scope namespace
            // declarations made explicit, so match on the tag name only.
            var foreign = resaved.IndexOf("<crs:MaskGroupBasedCorrections", StringComparison.Ordinal);
            var modeled = resaved.IndexOf("<crs:GradientBasedCorrections>", StringComparison.Ordinal);
            Assert.True(foreign >= 0 && modeled > foreign, resaved);
            Assert.Equal(resaved, XmpWriter.Serialize(XmpParser.Parse(resaved)!));
        }

        /// <summary>
        /// Real files in a temp directory through the on-disk store
        /// (CLAUDE.md: no mocks for the sidecar layer).
        /// </summary>
        [Fact]
        public void RoundTripsThroughARealSidecarFile()
        {
            var rawPath = Path.Combine(_dir, "photo.dng");
            File.WriteAllText(SidecarStore.SidecarPathFor(rawPath), Sidecar(CanonicalBlock));

            var loaded = SidecarStore.Load(rawPath);
            Assert.NotNull(loaded);
            Assert.Equal(new[] { LinearLayer, RadialLayer }, loaded!.Adjustments.LocalAdjustments);

            loaded.Adjustments.Exposure = 1.25;
            SidecarStore.Save(rawPath, loaded);
            var first = File.ReadAllText(SidecarStore.SidecarPathFor(rawPath));
            Assert.Contains("crs:Exposure2012=\"1.25\"", first);
            Assert.Contains(CanonicalBlock, first);

            var reloaded = SidecarStore.Load(rawPath);
            Assert.NotNull(reloaded);
            Assert.Equal(new[] { LinearLayer, RadialLayer }, reloaded!.Adjustments.LocalAdjustments);
            SidecarStore.Save(rawPath, reloaded);
            Assert.Equal(first, File.ReadAllText(SidecarStore.SidecarPathFor(rawPath)));
        }

        // ── Tolerant reader ──────────────────────────────────────────────────

        [Fact]
        public void UnrecognizedMaskKindDropsThatCorrectionOnly()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:What=\"Correction\" crs:CorrectionActive=\"True\" crs:LocalExposure2012=\"1\"",
                "<rdf:li crs:What=\"Mask/Brush\" crs:MaskValue=\"1\"/>")));
            Assert.NotNull(doc);
            Assert.Empty(doc!.Adjustments.LocalAdjustments);
            Assert.Empty(doc.PassthroughNodes);
        }

        [Fact]
        public void InactiveCorrectionIsDropped()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:What=\"Correction\" crs:CorrectionActive=\"False\" crs:LocalExposure2012=\"2\"",
                FullFrameGradient)));
            Assert.Empty(doc!.Adjustments.LocalAdjustments);
        }

        [Fact]
        public void CorrectionAmountScalesEverySlider()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:What=\"Correction\" crs:CorrectionAmount=\"0.5\" crs:LocalExposure2012=\"2\" crs:LocalContrast2012=\"-40\"",
                FullFrameGradient)));
            var layer = Assert.Single(doc!.Adjustments.LocalAdjustments);
            Assert.Equal(new PartialAdjustments { Exposure = 1, Contrast = -20 }, layer.Adjustments);
        }

        [Fact]
        public void CorrectionAmountScalesHueWithoutChangingColorSelection()
        {
            var doc = XmpParser.Parse(Sidecar(CanonicalBlock.Replace(
                "crs:CorrectionAmount=\"1\"", "crs:CorrectionAmount=\"0.5\"")))!;
            Assert.Equal(-17.5, doc.Adjustments.LocalAdjustments[0].Adjustments.Hue);
            Assert.Equal(0, doc.Adjustments.LocalAdjustments[1].Adjustments.Hue);
            Assert.Equal(LinearLayer.Range, doc.Adjustments.LocalAdjustments[0].Range);
            Assert.Equal(RadialLayer.Range, doc.Adjustments.LocalAdjustments[1].Range);
        }

        [Theory]
        [InlineData("http://ns.justmaple.app/photo/1.0/")]
        [InlineData("http://ns.justmaple.app/1.0/")]
        public void AcceptsRemappedAndLegacyNamespaces(string uri)
        {
            var xml = Sidecar(CanonicalBlock).Replace("http://ns.justmaple.app/photo/1.0/", uri)
                .Replace("crs:", "camera:").Replace("xmlns:crs=", "xmlns:camera=")
                .Replace("papp:", "maple:").Replace("xmlns:papp=", "xmlns:maple=");
            Assert.Equal(new[] { LinearLayer, RadialLayer }, XmpParser.Parse(xml)!.Adjustments.LocalAdjustments);
        }

        [Fact]
        public void MissingColorCoordinatesUseCoreDefaultsAndExplicitZeroSurvives()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:LocalHue=\"0\" papp:RangeKind=\"Color\" papp:RangeHue=\"0\" papp:RangeFeather=\"0\"",
                FullFrameGradient)))!;
            var layer = Assert.Single(doc.Adjustments.LocalAdjustments);
            Assert.Equal(new ColorRangeRefinement(0, 25, 0.02, 0.15, 0.95, 0), layer.Range);
            Assert.Equal(new PartialAdjustments { Hue = 0 }, layer.Adjustments);
            Assert.False(layer.Adjustments.IsEmpty);
            Assert.Equal(layer, Assert.Single(doc.Adjustments.Clone().LocalAdjustments));
        }

        [Theory]
        [InlineData("")]
        [InlineData("papp:RangeKind=\"Future\"")]
        [InlineData("papp:RangeKind=\"Color\" papp:RangeHue=\"NaN\"")]
        public void AbsentUnknownAndCorruptRangesStayAbsent(string attrs)
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection($"crs:LocalHue=\"NaN\" {attrs}", FullFrameGradient)))!;
            var layer = Assert.Single(doc.Adjustments.LocalAdjustments);
            Assert.Null(layer.Range);
            Assert.True(layer.Adjustments.IsEmpty);
            var xml = XmpWriter.Serialize(doc);
            Assert.DoesNotContain("RangeKind", xml);
            Assert.DoesNotContain("LocalHue", xml);
        }

        [Fact]
        public void MissingRequiredGeometryDropsTheMaskRatherThanInventingADefault()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:What=\"Correction\" crs:LocalExposure2012=\"1\"",
                "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroY=\"0\" crs:FullX=\"1\" crs:FullY=\"1\"/>")));
            Assert.Empty(doc!.Adjustments.LocalAdjustments);
        }

        [Fact]
        public void NonSelfClosingLeafAndCaseInsensitiveBooleans()
        {
            var doc = XmpParser.Parse(Sidecar(GradientCorrection(
                "crs:What=\"Correction\" crs:CorrectionActive=\"on\" crs:LocalExposure2012=\"0.5\"",
                "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroX=\"0.1\" crs:ZeroY=\"0.2\" crs:FullX=\"0.9\" crs:FullY=\"0.8\"></rdf:li>")));
            Assert.Equal(new[]
            {
                new LocalAdjustment(
                    new LinearMask(new MaskPoint(0.1, 0.2), new MaskPoint(0.9, 0.8), 0.5),
                    new PartialAdjustments { Exposure = 0.5 }),
            }, doc!.Adjustments.LocalAdjustments);
        }

        [Fact]
        public void ImportsALightroomRadialCorrectionIgnoringUnmodeledAttributes()
        {
            var doc = XmpParser.Parse(Sidecar(string.Join("\n", new[]
            {
                "      <crs:CircularGradientBasedCorrections>",
                "        <rdf:Seq>",
                "          <rdf:li>",
                "            <rdf:Description crs:What=\"Correction\" crs:CorrectionAmount=\"1\" crs:CorrectionActive=\"true\"",
                "              crs:LocalSaturation=\"-15\" crs:LocalClarity2012=\"20\" crs:LocalTemperature=\"-50\">",
                "              <crs:CorrectionMasks>",
                "                <rdf:Seq>",
                "                  <rdf:li crs:What=\"Mask/CircularGradient\" crs:MaskValue=\"1\"",
                "                    crs:Top=\"0.25\" crs:Left=\"0.25\" crs:Bottom=\"0.5\" crs:Right=\"0.75\"",
                "                    crs:Angle=\"0\" crs:Midpoint=\"50\" crs:Roundness=\"20\" crs:Feather=\"50\" crs:Flipped=\"false\"",
                "                    crs:MaskName=\"Radial Gradient 1\" crs:MaskSyncID=\"ABC\"/>",
                "                </rdf:Seq>",
                "              </crs:CorrectionMasks>",
                "            </rdf:Description>",
                "          </rdf:li>",
                "        </rdf:Seq>",
                "      </crs:CircularGradientBasedCorrections>",
            })));
            Assert.Equal(new[]
            {
                new LocalAdjustment(
                    new RadialMask(new MaskPoint(0.5, 0.375), new MaskPoint(0.25, 0.125), 0, 0.5, false),
                    new PartialAdjustments { Saturation = -15, Temperature = -50 }),
            }, doc!.Adjustments.LocalAdjustments);
        }
    }
}
