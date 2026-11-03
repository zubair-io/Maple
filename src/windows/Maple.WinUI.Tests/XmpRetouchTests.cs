// XmpRetouchTests — the Windows side of the clone / heal brush's sidecar
// contract (#3409/#3888). The immutable repair model retains the complete
// subtree and XmpWriter re-emits it at its original position. These tests
// pin preservation for Mac- and Lightroom-authored sidecars; authoring and
// native decode tests live in RetouchAuthoringTests.
//
// The literal below is the same canonical block the Rust
// (`tests_retouch.rs`), Swift (`RetouchXMPTests.swift`) and TypeScript
// (`retouch.spec.ts`) suites carry, so a change to the wire form fails here
// too rather than silently leaving Windows behind.

using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpRetouchTests
    {
        internal static readonly string DocWithTwoSpots = string.Join("\n", new[]
        {
            "<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
            "      crs:Exposure2012=\"0.5\"",
            "      crs:HasSettings=\"True\">",
            "      <crs:RetouchAreas>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:SpotType=\"heal\"",
            "              crs:SourceState=\"sourceSetExplicitly\"",
            "              crs:Method=\"circle\"",
            "              crs:SourceX=\"0.750000\"",
            "              crs:SourceY=\"0.500000\"",
            "              crs:Opacity=\"1.000000\"",
            "              crs:Feather=\"0.500000\"",
            "              crs:Seed=\"0\">",
            "              <crs:Masks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/CircularGradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:X=\"0.250000\"",
            "                    crs:Y=\"0.500000\"",
            "                    crs:Radius=\"0.050000\"",
            "                    crs:Flow=\"1\"",
            "                    crs:CenterWeight=\"0\"/>",
            "                </rdf:Seq>",
            "              </crs:Masks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:SpotType=\"clone\"",
            "              crs:SourceState=\"sourceSetExplicitly\"",
            "              crs:Method=\"circle\"",
            "              crs:SourceX=\"0.600000\"",
            "              crs:SourceY=\"0.300000\"",
            "              crs:Opacity=\"0.750000\"",
            "              crs:Feather=\"0.000000\"",
            "              crs:Seed=\"0\">",
            "              <crs:Masks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/CircularGradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:X=\"0.800000\"",
            "                    crs:Y=\"0.200000\"",
            "                    crs:Radius=\"0.012500\"",
            "                    crs:Flow=\"1\"",
            "                    crs:CenterWeight=\"0\"/>",
            "                </rdf:Seq>",
            "              </crs:Masks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:RetouchAreas>",
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        /// <summary>
        /// Every spot's identity — both kinds, both destinations, both
        /// sources, both radii — survives a read-modify-write, and the
        /// container is written exactly once.
        /// </summary>
        [Fact]
        public void RetouchAreasSurviveAReadModifyWrite()
        {
            var doc = XmpParser.Parse(DocWithTwoSpots);
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            Assert.Equal(2, CountOccurrences(resaved, "crs:SpotType="));
            Assert.Single(SplitCount(resaved, "<crs:RetouchAreas"));
            foreach (var fragment in new[]
            {
                "crs:SpotType=\"heal\"",
                "crs:SpotType=\"clone\"",
                "crs:SourceX=\"0.750000\"",
                "crs:SourceY=\"0.500000\"",
                "crs:SourceX=\"0.600000\"",
                "crs:SourceY=\"0.300000\"",
                "crs:What=\"Mask/CircularGradient\"",
                "crs:X=\"0.250000\"",
                "crs:Radius=\"0.050000\"",
                "crs:X=\"0.800000\"",
                "crs:Radius=\"0.012500\"",
                "crs:Feather=\"0.500000\"",
                "crs:Opacity=\"0.750000\"",
            })
            {
                Assert.Contains(fragment, resaved);
            }
        }

        /// <summary>
        /// Editing a field Windows DOES model must not disturb the spots —
        /// the case a real Windows session hits.
        /// </summary>
        [Fact]
        public void EditingAModeledFieldLeavesTheSpotsIntact()
        {
            var doc = XmpParser.Parse(DocWithTwoSpots);
            Assert.NotNull(doc);
            doc!.Adjustments.Exposure = -1.25;

            var resaved = XmpWriter.Serialize(doc);

            Assert.Contains("crs:Exposure2012=\"-1.25\"", resaved);
            Assert.Equal(2, CountOccurrences(resaved, "crs:SpotType="));
        }

        /// <summary>
        /// A second round trip is a fixed point: the preserved subtree does
        /// not accumulate re-serialization drift.
        /// </summary>
        [Fact]
        public void ASecondRoundTripIsAFixedPoint()
        {
            var first = XmpWriter.Serialize(XmpParser.Parse(DocWithTwoSpots)!);
            var second = XmpWriter.Serialize(XmpParser.Parse(first)!);

            Assert.Equal(first, second);
        }

        /// <summary>
        /// #4473: a list without the stamp predates the upright frame; Windows
        /// stored it in the decode frame, so it is held back from editing and
        /// written back exactly as read until the RAW's orientation is known.
        /// </summary>
        [Fact]
        public void AnUnstampedMapleListIsLegacyAndIsNotRestamped()
        {
            var doc = XmpParser.Parse(DocWithTwoSpots)!;
            Assert.True(doc.Adjustments.Retouch.IsLegacyFrame);
            Assert.Throws<System.InvalidOperationException>(() =>
                XmpRetouch.Add(doc.Adjustments.Retouch, new(RetouchKind.Heal, .5, .5, .6, .5, .02)));
            Assert.DoesNotContain("RetouchFrameVersion", XmpWriter.Serialize(doc));
        }

        [Fact]
        public void AListWithoutTheMapleNamespaceIsAlreadyUpright()
        {
            var foreign = DocWithTwoSpots.Replace("      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"\n", "");
            Assert.DoesNotContain("xmlns:papp", foreign);
            Assert.False(XmpParser.Parse(foreign)!.Adjustments.Retouch.IsLegacyFrame);
        }

        [Fact]
        public void AnEmbeddedWorkflowRecordDoesNotMakeALightroomListLegacy()
        {
            var foreign = DocWithTwoSpots.Replace("      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"\n", "");
            var close = foreign.LastIndexOf("</rdf:Description>", System.StringComparison.Ordinal);
            var withWorkflow = foreign.Insert(close,
                "<papp:Workflow xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:Record=\"{}\"/>\n");
            Assert.False(XmpParser.Parse(withWorkflow)!.Adjustments.Retouch.IsLegacyFrame);
            Assert.Contains("papp:RetouchFrameVersion=\"2\"", XmpWriter.Serialize(XmpParser.Parse(withWorkflow)!));
        }

        [Fact]
        public void TheUprightStampIsWrittenOnceAndSurvivesARoundTrip()
        {
            var doc = XmpParser.Parse(DocWithTwoSpots)!;
            doc.Adjustments.Retouch = XmpRetouch.ToUpright(doc.Adjustments.Retouch, 1, 4000, 3000);
            var saved = XmpWriter.Serialize(doc);
            Assert.Equal(1, CountOccurrences(saved, "papp:RetouchFrameVersion=\"2\""));
            var reread = XmpParser.Parse(saved)!;
            Assert.False(reread.Adjustments.Retouch.IsLegacyFrame);
            Assert.Equal(1, CountOccurrences(XmpWriter.Serialize(reread), "papp:RetouchFrameVersion"));
            Assert.DoesNotContain("RetouchFrameVersion", XmpWriter.Serialize(new()));
        }

        /// <summary>
        /// The destination of a sensor-frame spot at (.2, .3) lands where the
        /// known EXIF orientation puts that sensor location in the upright image;
        /// the same vectors pin raw-core's display-to-sensor mapping.
        /// </summary>
        [Theory]
        [InlineData(1, .2, .3)]
        [InlineData(2, .8, .3)]
        [InlineData(3, .8, .7)]
        [InlineData(4, .2, .7)]
        [InlineData(5, .3, .2)]
        [InlineData(6, .7, .2)]
        [InlineData(7, .7, .8)]
        [InlineData(8, .3, .8)]
        public void ConversionFollowsTheExifOrientation(int orientation, double x, double y)
        {
            var legacy = XmpParser.Parse(DocWithTwoSpots)!.Adjustments.Retouch;
            var spot = legacy.Spots[0].Spot with { X = .2, Y = .3, SourceX = .2, SourceY = .3 };
            var oriented = XmpRetouch.ToUpright(
                XmpParser.Parse(Replace(DocWithTwoSpots, spot))!.Adjustments.Retouch, orientation, 4000, 3000);
            Assert.False(oriented.IsLegacyFrame);
            var converted = oriented.Spots[0].Spot;
            Assert.Equal(x, converted.X, 6);
            Assert.Equal(y, converted.Y, 6);
            Assert.Equal(x, converted.SourceX, 6);
            Assert.Equal(y, converted.SourceY, 6);
        }

        [Theory]
        [InlineData(1, .05)]
        [InlineData(3, .05)]
        [InlineData(6, .05 * 4000 / 3000)]
        [InlineData(8, .05 * 4000 / 3000)]
        [InlineData(5, .05 * 4000 / 3000)]
        public void ConversionKeepsTheDiscThePixelSizeItWas(int orientation, double radius)
        {
            var converted = XmpRetouch.ToUpright(
                XmpParser.Parse(DocWithTwoSpots)!.Adjustments.Retouch, orientation,
                orientation >= 5 ? 3000 : 4000, orientation >= 5 ? 4000 : 3000);
            Assert.Equal(radius, converted.Spots[0].Spot.Radius, 6);
        }

        [Fact]
        public void ConversionPreservesUnknownEntriesAndMaskAttributes()
        {
            var withUnknown = DocWithTwoSpots.Replace(
                "crs:SpotType=\"clone\"", "crs:SpotType=\"future\" crs:Payload=\"keep\"");
            var converted = XmpRetouch.ToUpright(
                XmpParser.Parse(withUnknown)!.Adjustments.Retouch, 6, 4000, 3000);
            Assert.Single(converted.Spots);
            Assert.Contains("crs:Payload=\"keep\"", converted.Xml);
            Assert.Contains("crs:SpotType=\"future\"", converted.Xml);
        }

        private static string Replace(string document, RetouchSpot spot)
        {
            return document
                .Replace("crs:SourceX=\"0.750000\"", $"crs:SourceX=\"{spot.SourceX:F6}\"")
                .Replace("crs:SourceY=\"0.500000\"", $"crs:SourceY=\"{spot.SourceY:F6}\"")
                .Replace("crs:X=\"0.250000\"", $"crs:X=\"{spot.X:F6}\"")
                .Replace("crs:Y=\"0.500000\"", $"crs:Y=\"{spot.Y:F6}\"");
        }

        private static int CountOccurrences(string haystack, string needle)
        {
            var count = 0;
            var index = 0;
            while ((index = haystack.IndexOf(needle, index, System.StringComparison.Ordinal)) >= 0)
            {
                count++;
                index += needle.Length;
            }

            return count;
        }

        /// <summary>Wraps <see cref="CountOccurrences"/> so `Assert.Single`
        /// reads naturally for the "exactly one container" assertion.</summary>
        private static int[] SplitCount(string haystack, string needle) =>
            new int[CountOccurrences(haystack, needle)];
    }
}
