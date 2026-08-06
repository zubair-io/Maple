// XmpCanonicalEnvelopeTests — the byte-canonical envelope claim from
// `docs/xmp-canonical-format.md`, checked two ways:
//
//  1. `MinimalDocumentMatchesHandComputedGolden` — a tiny, fully hand-traced
//     document (one numeric field, one culling field) compared against a
//     literal built line-by-line in this file. Small on purpose: every line
//     of the expected literal below was derived by reading XmpWriter.cs's
//     actual control flow (attribute collection order, then
//     `SortedAttributeParts`, then envelope assembly), not by running the
//     code — this repo's CI runner is windows-latest and this suite could
//     not be executed locally while writing it (no `dotnet` on this
//     machine), so keeping the traced literal small keeps that trace
//     checkable by a reviewer.
//  2. Invariant checks in the style of `XMPCanonicalFormatTests
//     .testCanonicalInvariants` (Swift) — namespace URI/order, no `x:xmptk`,
//     attribute sort order, the indent ladder — run against the full
//     `WindowsFixtureModel`, which is a closer analogue of real sidecar
//     traffic than the minimal case above.

using System;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpCanonicalEnvelopeTests
    {
        [Fact]
        public void MinimalDocumentMatchesHandComputedGolden()
        {
            var doc = new XmpSidecarDocument { Rating = 3, Flag = "pick" };
            doc.Adjustments.Exposure = 0.5;

            var expected = string.Join("\n", new[]
            {
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
                "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
                "      xmp:Rating=\"3\"",
                "      crs:Exposure2012=\"0.5\"",
                "      crs:HasSettings=\"True\"",
                "      crs:ProcessVersion=\"11.0\"",
                "      crs:Version=\"11.0\"",
                "      papp:Flag=\"pick\"/>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            Assert.Equal(expected, XmpWriter.Serialize(doc));
        }

        [Fact]
        public void CanonicalUriAndNamespaceOrderAndNoToolkit()
        {
            var doc = XmpWriter.Serialize(WindowsFixtureModel.BuildDocument());

            Assert.Contains("      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"", doc);

            var xmpAt = doc.IndexOf("xmlns:xmp=", StringComparison.Ordinal);
            var crsAt = doc.IndexOf("xmlns:crs=", StringComparison.Ordinal);
            var pappAt = doc.IndexOf("xmlns:papp=", StringComparison.Ordinal);
            Assert.True(xmpAt >= 0 && crsAt >= 0 && pappAt >= 0,
                "all three core namespace declarations must be present");
            Assert.True(xmpAt < crsAt && crsAt < pappAt,
                "namespace declarations must be in canonical order: xmp, crs, papp");

            Assert.DoesNotContain("x:xmptk", doc);
        }

        [Fact]
        public void AttributesSortByNamespacePriorityThenAlphabetically()
        {
            var doc = XmpWriter.Serialize(WindowsFixtureModel.BuildDocument());

            var rating = doc.IndexOf("xmp:Rating=", StringComparison.Ordinal);
            var blacks = doc.IndexOf("crs:Blacks2012=", StringComparison.Ordinal);
            var whites = doc.IndexOf("crs:Whites2012=", StringComparison.Ordinal);
            var brightness = doc.IndexOf("papp:Brightness=", StringComparison.Ordinal);
            Assert.True(rating >= 0 && blacks >= 0 && whites >= 0 && brightness >= 0,
                "expected attributes missing from the canonical document");

            // xmp: (0) < crs: (1) < papp: (2); alphabetical within crs:
            // ("Blacks2012" < "Whites2012" ordinally).
            Assert.True(rating < blacks);
            Assert.True(blacks < whites);
            Assert.True(whites < brightness);
        }

        [Fact]
        public void ToneCurveChildrenSitOnTheCanonicalIndentLadder()
        {
            var doc = XmpWriter.Serialize(WindowsFixtureModel.BuildDocument());

            Assert.Contains("      <papp:SceneLinearToneCurve>", doc);
            Assert.Contains("        <rdf:Seq>", doc);
            Assert.Contains("          <rdf:li>0, 0</rdf:li>", doc);
        }
    }
}
