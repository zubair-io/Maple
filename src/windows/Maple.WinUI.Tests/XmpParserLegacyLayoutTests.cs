// XmpParserLegacyLayoutTests — a sidecar in the pre-#1577 layout (the old
// `papp:` URI, `crs, xmp, papp` namespace declaration order, no
// `rdf:about`, unsorted attributes) must still parse correctly. Mirrors
// `XMPCanonicalFormatTests.testLegacyLayoutSidecarStillParses` (Swift),
// scoped to the fields `XmpParser` actually models.

using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpParserLegacyLayoutTests
    {
        private static readonly string LegacyXml = string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
            "      xmlns:papp=\"http://ns.justmaple.app/1.0/\"",
            "      crs:Temperature=\"5200\"",
            "      crs:Tint=\"-14.5\"",
            "      papp:WbScaleVersion=\"5\"",
            "      crs:Exposure2012=\"0.50\"",
            "      crs:Contrast2012=\"12\"",
            "      crs:Shadows2012=\"25\"",
            "      crs:SharpenRadius=\"1.4\"",
            "      papp:CaptureSharpeningSigma=\"0.8\"",
            "      papp:Profile=\"Neutral\"",
            "      papp:Flag=\"pick\"",
            "      papp:ColorLabel=\"green\"",
            "      xmp:Rating=\"4\">",
            "      <papp:SceneLinearToneCurve>",
            "        <rdf:Seq>",
            "          <rdf:li>0, 0</rdf:li>",
            "          <rdf:li>127.5, 140.25</rdf:li>",
            "        </rdf:Seq>",
            "      </papp:SceneLinearToneCurve>",
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        [Fact]
        public void ParsesEveryModeledField()
        {
            var doc = XmpParser.Parse(LegacyXml);
            Assert.NotNull(doc);

            Assert.Equal(5200, doc!.Adjustments.Temperature, precision: 9);
            Assert.Equal(-14.5, doc.Adjustments.Tint, precision: 9);
            Assert.Equal(5, doc.WbScaleVersion);
            Assert.Equal(0.5, doc.Adjustments.Exposure, precision: 9);
            Assert.Equal(12, doc.Adjustments.Contrast, precision: 9);
            Assert.Equal(25, doc.Adjustments.Shadows, precision: 9);
            Assert.Equal(1.4, doc.Adjustments.SharpenRadius, precision: 9);
            Assert.Equal(0.8, doc.Adjustments.CaptureSharpeningSigma, precision: 9);
            Assert.Equal(ProfileMode.Neutral, doc.Adjustments.Profile);
            Assert.Equal(4, doc.Rating);
            Assert.Equal("pick", doc.Flag);
            Assert.Equal("green", doc.ColorLabel);
        }

        [Fact]
        public void ParsesToneCurveFromTheLegacyLayout()
        {
            var doc = XmpParser.Parse(LegacyXml);
            Assert.NotNull(doc);

            Assert.Equal(2, doc!.Adjustments.ToneCurveLuma.Count);
            Assert.Equal(new CurvePoint(0, 0), doc.Adjustments.ToneCurveLuma[0]);
            Assert.Equal(new CurvePoint(127.5, 140.25), doc.Adjustments.ToneCurveLuma[1]);
        }

        [Fact]
        public void LegacyDocumentUpgradesToCanonicalLayoutOnResave()
        {
            var doc = XmpParser.Parse(LegacyXml);
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            Assert.Contains("xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"", resaved);
            Assert.DoesNotContain("http://ns.justmaple.app/1.0/", resaved);
            Assert.Contains("rdf:about=\"\"", resaved);
        }
    }
}
