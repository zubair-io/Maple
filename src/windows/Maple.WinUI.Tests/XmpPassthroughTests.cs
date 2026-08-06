// XmpPassthroughTests — unknown attributes and unknown child elements must
// survive a read-modify-write untouched (`docs/xmp-canonical-format.md` §
// "Passthrough"). Mirrors the intent of `XMPPassthroughTests.swift`, scoped
// to what `XmpParser`/`XmpWriter` implement: attribute passthrough (with the
// namespace declaration it needs) and node passthrough, each asserted to
// preserve its own relative order.
//
// `ChildOrderIsNotPreservedRelativeToModeledToneCurves` documents a real,
// deliberately-not-corrected divergence found while writing this suite —
// filed as a follow-up: #2671. It is written to assert the CURRENT behavior (a
// characterization test), not the canonical behavior, because Windows never
// promised source-order preservation relative to modeled fields in the
// first place — only among passthrough nodes themselves, which is what the
// other tests in this file check and which does hold today.

using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpPassthroughTests
    {
        private static readonly string DocWithUnknownAttributeAndNode = string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
            "      xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\"",
            "      crs:Exposure2012=\"0.5\"",
            "      crs:RawFileName=\"IMG_0001.dng\"",
            "      crs:HasSettings=\"True\">",
            "      <xmpMM:History>",
            "        <rdf:Seq>",
            "          <rdf:li>edited in Lightroom</rdf:li>",
            "        </rdf:Seq>",
            "      </xmpMM:History>",
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        [Fact]
        public void UnknownAttributeSurvivesWithItsValue()
        {
            var doc = XmpParser.Parse(DocWithUnknownAttributeAndNode);
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            Assert.Contains("crs:RawFileName=\"IMG_0001.dng\"", resaved);
        }

        [Fact]
        public void UnknownChildElementSurvivesVerbatim()
        {
            var doc = XmpParser.Parse(DocWithUnknownAttributeAndNode);
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            // The opening tag carries an inline `xmlns:xmpMM` declaration: the
            // parser captures passthrough nodes with `XElement.ToString()`
            // (XmpParser.cs), which self-declares any prefix inherited from an
            // ancestor because the element is being serialized as its own root.
            // So match the tag name only — asserting `"<xmpMM:History>"` would
            // fail on preserved-and-correct output.
            Assert.Contains("<xmpMM:History", resaved);
            Assert.Contains("<rdf:li>edited in Lightroom</rdf:li>", resaved);
            Assert.Contains("</xmpMM:History>", resaved);
        }

        /// <summary>
        /// Exercises the OTHER passthrough-namespace path: an unrecognized
        /// namespace on a PASSTHROUGH ATTRIBUTE (not a child node) needs its
        /// own `xmlns:` declaration hoisted onto `rdf:Description`, tracked
        /// via `XmpSidecarDocument.PassthroughNamespaces`
        /// (`CapturePassthroughAttribute` in XmpParser.cs). Distinct from
        /// `UnknownChildElementSurvivesVerbatim`'s node, whose own
        /// `xmlns:xmpMM` survives via `XElement.ToString()` self-declaring
        /// regardless of this mechanism — this test would pass even if
        /// `PassthroughNamespaces` were never wired up, so it doesn't
        /// exercise the same code path.
        /// </summary>
        [Fact]
        public void UnknownNamespaceAttributeGetsItsOwnDeclarationHoistedOntoDescription()
        {
            var xml = string.Join("\n", new[]
            {
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
                "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
                "      xmlns:custom=\"http://example.com/custom/1.0/\"",
                "      crs:HasSettings=\"True\"",
                "      custom:rating=\"5\">",
                "    </rdf:Description>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            Assert.Contains("xmlns:custom=\"http://example.com/custom/1.0/\"", resaved);
            Assert.Contains("custom:rating=\"5\"", resaved);
        }

        [Fact]
        public void MultipleUnknownChildElementsKeepTheirOwnRelativeOrder()
        {
            var xml = string.Join("\n", new[]
            {
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
                "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
                "      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"",
                "      crs:HasSettings=\"True\">",
                "      <dc:title>",
                "        <rdf:Alt>",
                "          <rdf:li xml:lang=\"x-default\">first</rdf:li>",
                "        </rdf:Alt>",
                "      </dc:title>",
                "      <dc:description>",
                "        <rdf:Alt>",
                "          <rdf:li xml:lang=\"x-default\">second</rdf:li>",
                "        </rdf:Alt>",
                "      </dc:description>",
                "    </rdf:Description>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            var firstAt = resaved.IndexOf("first", System.StringComparison.Ordinal);
            var secondAt = resaved.IndexOf("second", System.StringComparison.Ordinal);
            // Guard against the -1 sentinel: if either element were dropped on
            // resave, its IndexOf would return -1, which is less than any real
            // index and would make the order assertion below pass despite the
            // content loss.
            Assert.True(firstAt >= 0 && secondAt >= 0, "both unknown child elements must survive the resave");
            Assert.True(firstAt < secondAt,
                "unknown child elements must keep their own relative order across a resave");
        }

        /// <summary>
        /// KNOWN GAP (filed as a follow-up: #2671): `XmpWriter.BuildChildren`
        /// always emits the modeled tone-curve blocks first, then every passthrough node
        /// after, regardless of where those nodes sat relative to the tone
        /// curve in the source document. Swift and TypeScript don't have
        /// this failure mode for `dc:subject`/keywords specifically because
        /// they model keywords as a first-class field with its own fixed
        /// canonical position ahead of the tone-curve blocks (see
        /// `xmp-serializer.service.ts`'s child-ordering comment: "title/
        /// creator/description first, then keywords (dc:subject), then
        /// [tone curves]") — Windows has no such field, so any unmodeled
        /// child content that a real Maple/Lightroom sidecar carries ahead
        /// of a tone curve gets silently reordered to after it on a Windows
        /// read-modify-write. This test pins down the CURRENT behavior so a
        /// change to it doesn't slip by unnoticed; it does not assert the
        /// canonical/expected behavior, because Windows never modeled
        /// (or promised to preserve the position of) that content.
        /// </summary>
        [Fact]
        public void ChildOrderIsNotPreservedRelativeToModeledToneCurves()
        {
            var xml = string.Join("\n", new[]
            {
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
                "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
                "      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"",
                "      crs:HasSettings=\"True\">",
                "      <dc:subject>",
                "        <rdf:Bag>",
                "          <rdf:li>alpha</rdf:li>",
                "        </rdf:Bag>",
                "      </dc:subject>",
                "      <papp:SceneLinearToneCurve>",
                "        <rdf:Seq>",
                "          <rdf:li>0, 0</rdf:li>",
                "          <rdf:li>255, 255</rdf:li>",
                "        </rdf:Seq>",
                "      </papp:SceneLinearToneCurve>",
                "    </rdf:Description>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });
            // Source order: dc:subject BEFORE the tone curve — the canonical
            // order Swift/TS also use for their own dc:subject field.

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);
            var resaved = XmpWriter.Serialize(doc!);

            var subjectAt = resaved.IndexOf("dc:subject", System.StringComparison.Ordinal);
            var curveAt = resaved.IndexOf("SceneLinearToneCurve", System.StringComparison.Ordinal);
            Assert.True(subjectAt >= 0 && curveAt >= 0, "both blocks must survive the resave");

            // Documents today's actual (reordered) output. If this starts
            // failing because someone fixed the ordering, that's good news —
            // delete this test (and close the follow-up ticket) rather than
            // updating the assertion.
            Assert.True(curveAt < subjectAt,
                "known gap (#2671): passthrough content is re-emitted after modeled tone-curve " +
                "blocks regardless of its original position");
        }
    }
}
