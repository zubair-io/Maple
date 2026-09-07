// XmpRetouchTests — the Windows side of the clone / heal brush's sidecar
// contract (#3409). Windows has no repair UI yet and does not MODEL the
// spot list; what it must do is never lose one. `crs:RetouchAreas` is an
// unrecognized child element, so it rides the generic node passthrough
// (`XmpParser.ParseChildren` → `XmpSidecarDocument.PassthroughNodes`,
// re-emitted by `XmpWriter.BuildChildren` at its original position) — these
// tests pin that, because a Windows read-modify-write of a Mac- or
// Lightroom-authored sidecar is exactly where the spots would vanish.
//
// The literal below is the same canonical block the Rust
// (`tests_retouch.rs`), Swift (`RetouchXMPTests.swift`) and TypeScript
// (`retouch.spec.ts`) suites carry, so a change to the wire form fails here
// too rather than silently leaving Windows behind.

using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpRetouchTests
    {
        private static readonly string DocWithTwoSpots = string.Join("\n", new[]
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
