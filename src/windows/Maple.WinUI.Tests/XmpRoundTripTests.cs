// XmpRoundTripTests — the write → parse → write fixed point
// (`docs/xmp-canonical-format.md` § "Test contract", item 4) and the
// field-level round trip (item 5), scoped to what `AdjustmentState` /
// `XmpSidecarDocument` actually model. Mirrors
// `XMPCanonicalFormatTests.testLegacySidecarUpgradesOnResave` (Swift) minus
// the real-file plumbing, which `SidecarStoreRoundTripTests` covers instead.

using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpRoundTripTests
    {
        [Fact]
        public void SerializeParseSerializeIsAFixedPoint()
        {
            var original = XmpWriter.Serialize(WindowsFixtureModel.BuildDocument());

            var parsed = XmpParser.Parse(original);
            Assert.NotNull(parsed);

            var resaved = XmpWriter.Serialize(parsed!);

            Assert.Equal(original, resaved);
        }

        [Fact]
        public void ParsedAdjustmentsMatchWhatWasWritten()
        {
            var written = WindowsFixtureModel.BuildDocument();
            var xml = XmpWriter.Serialize(written);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);

            AdjustmentStateAssert.Equal(written.Adjustments, parsed!.Adjustments);
        }

        [Fact]
        public void ParsedCullingFieldsMatchWhatWasWritten()
        {
            var written = WindowsFixtureModel.BuildDocument();
            var xml = XmpWriter.Serialize(written);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);

            Assert.Equal(written.Rating, parsed!.Rating);
            Assert.Equal(written.Flag, parsed.Flag);
            Assert.Equal(written.ColorLabel, parsed.ColorLabel);
        }

        [Fact]
        public void DefaultDocumentOmitsEveryOptionalField()
        {
            // The omit-at-default rule (`docs/xmp-canonical-format.md` §
            // "Number fields and defaults") means a fresh, untouched
            // adjustment state should produce only the three always-emitted
            // process-version attributes plus the canonical envelope — no
            // numeric field, no enum field, no culling attribute, no
            // children.
            var doc = new XmpSidecarDocument();

            var xml = XmpWriter.Serialize(doc);

            Assert.Contains("crs:HasSettings=\"True\"", xml);
            Assert.DoesNotContain("crs:Exposure2012", xml);
            Assert.DoesNotContain("crs:Temperature", xml);
            Assert.DoesNotContain("xmp:Rating", xml);
            Assert.DoesNotContain("papp:Flag", xml);
            Assert.DoesNotContain("papp:ColorLabel", xml);
            Assert.DoesNotContain("papp:SceneLinearToneCurve", xml);
            // Self-closing: no children means no ">\n...</rdf:Description>".
            Assert.DoesNotContain("</rdf:Description>", xml);
        }

        [Fact]
        public void DefaultDocumentIsItselfAFixedPoint()
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument());

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);

            Assert.Equal(xml, XmpWriter.Serialize(parsed!));
        }

        [Fact]
        public void ToneCurvePointsRoundTripInWireDomain()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(0, 0));
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(127.5, 140.25));
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(255, 255));

            var xml = XmpWriter.Serialize(doc);
            Assert.Contains("<papp:SceneLinearToneCurve>", xml);
            Assert.Contains("<rdf:li>127.5, 140.25</rdf:li>", xml);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            Assert.Equal(3, parsed!.Adjustments.ToneCurveLuma.Count);
            Assert.Equal(new CurvePoint(127.5, 140.25), parsed.Adjustments.ToneCurveLuma[1]);
        }

        [Fact]
        public void IdentityToneCurveEmitsNoElementAtAll()
        {
            // "The identity curve is the empty control-point list, and it
            // emits no element at all — never an empty rdf:Seq"
            // (docs/xmp-canonical-format.md § "Tone curves").
            var xml = XmpWriter.Serialize(new XmpSidecarDocument());

            Assert.DoesNotContain("rdf:Seq", xml);
            Assert.DoesNotContain("SceneLinearToneCurve", xml);
        }
    }
}
