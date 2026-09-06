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
            // adjustment state produces the three process attributes and
            // explicit Auto profile intent, with no optional numeric,
            // enum, culling attribute or children.
            var doc = new XmpSidecarDocument();

            var xml = XmpWriter.Serialize(doc);

            Assert.Contains("crs:HasSettings=\"True\"", xml);
            Assert.Contains("papp:Profile=\"Auto\"", xml);
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

        /// <summary>
        /// The model is `[0, 1]` and the wire is `[0, 255]` (#3234): a
        /// model point (0.5, 0.55) must serialize as `127.5, 140.25` — the
        /// same `rdf:li` text raw-core / Swift / TypeScript write for that
        /// point — and parse back to the same model value.
        /// </summary>
        [Fact]
        public void ToneCurvePointsRescaleToTheWireDomainOnWrite()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(0, 0));
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(0.5, 0.55));
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(1, 1));

            var xml = XmpWriter.Serialize(doc);
            Assert.Contains("<papp:SceneLinearToneCurve>", xml);
            Assert.Contains("<rdf:li>127.5, 140.25</rdf:li>", xml);
            Assert.Contains("<rdf:li>255, 255</rdf:li>", xml);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            Assert.Equal(3, parsed!.Adjustments.ToneCurveLuma.Count);
            Assert.Equal(0.5, parsed.Adjustments.ToneCurveLuma[1].X, precision: 12);
            Assert.Equal(0.55, parsed.Adjustments.ToneCurveLuma[1].Y, precision: 12);
            Assert.Equal(new CurvePoint(1, 1), parsed.Adjustments.ToneCurveLuma[2]);
        }

        /// <summary>
        /// A Lightroom / other-platform authored 3-point curve read from a
        /// sidecar lands on the model in `[0, 1]` and re-serializes to the
        /// identical bytes — the parse → write fixed point the #3234 fix
        /// must not disturb (the old writer would have emitted the
        /// `[0, 1]` model values raw, i.e. `0.5, 0.55`).
        /// </summary>
        [Fact]
        public void AuthoredThreePointCurveRoundTripsByteForByte()
        {
            var authored = string.Join("\n", new[]
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
                "      crs:Version=\"11.0\"",
                "      papp:Profile=\"Auto\">",
                "      <crs:ToneCurvePV2012>",
                "        <rdf:Seq>",
                "          <rdf:li>0, 0</rdf:li>",
                "          <rdf:li>127.5, 140.25</rdf:li>",
                "          <rdf:li>255, 255</rdf:li>",
                "        </rdf:Seq>",
                "      </crs:ToneCurvePV2012>",
                "    </rdf:Description>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            var parsed = XmpParser.Parse(authored);
            Assert.NotNull(parsed);
            var curve = parsed!.Adjustments.DisplayToneCurveLuma;
            Assert.Equal(3, curve.Count);
            Assert.All(curve, p =>
            {
                Assert.InRange(p.X, 0.0, 1.0);
                Assert.InRange(p.Y, 0.0, 1.0);
            });
            Assert.Equal(0.5, curve[1].X, precision: 12);
            Assert.Equal(0.55, curve[1].Y, precision: 12);

            Assert.Equal(authored, XmpWriter.Serialize(parsed!));
        }

        /// <summary>
        /// ACR's parametric split points (#2320 / #3223): a Lightroom-authored
        /// sidecar with moved `crs:Parametric{Shadow,Midtone,Highlight}Split`
        /// (the same 20 / 55 / 80 the raw-core and TypeScript suites use)
        /// lands on the model and survives a Windows re-save — the values
        /// used to be dropped on read and silently reset to 25 / 50 / 75.
        /// </summary>
        [Fact]
        public void LightroomSplitPointsSurviveParseAndResave()
        {
            const string lightroom = """
                <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
                <x:xmpmeta xmlns:x="adobe:ns:meta/">
                  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                    <rdf:Description rdf:about=""
                      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                      crs:Version="15.2"
                      crs:ProcessVersion="11.0"
                      crs:ParametricShadows="-100"
                      crs:ParametricDarks="25"
                      crs:ParametricLights="-50"
                      crs:ParametricHighlights="100"
                      crs:ParametricShadowSplit="20"
                      crs:ParametricMidtoneSplit="55"
                      crs:ParametricHighlightSplit="80"/>
                  </rdf:RDF>
                </x:xmpmeta>
                <?xpacket end="w"?>
                """;

            var parsed = XmpParser.Parse(lightroom);
            Assert.NotNull(parsed);
            var a = parsed!.Adjustments;
            Assert.Equal(20, a.ParametricShadowSplit);
            Assert.Equal(55, a.ParametricMidtoneSplit);
            Assert.Equal(80, a.ParametricHighlightSplit);

            var resaved = XmpWriter.Serialize(parsed);
            Assert.Contains("crs:ParametricShadowSplit=\"20\"", resaved);
            Assert.Contains("crs:ParametricMidtoneSplit=\"55\"", resaved);
            Assert.Contains("crs:ParametricHighlightSplit=\"80\"", resaved);

            var reparsed = XmpParser.Parse(resaved);
            Assert.NotNull(reparsed);
            AdjustmentStateAssert.Equal(a, reparsed!.Adjustments);
        }

        /// <summary>
        /// The split points have non-zero defaults (25 / 50 / 75), so the
        /// omit-at-default rule compares against those — a fresh model
        /// writes none of the three, and a fractional value goes through the
        /// canonical two-decimal codec like raw-core's writer (`55.25`).
        /// </summary>
        [Fact]
        public void SplitPointsOmitAtTheirOwnDefaultsAndKeepFractions()
        {
            Assert.DoesNotContain("ParametricShadowSplit", XmpWriter.Serialize(new XmpSidecarDocument()));
            Assert.DoesNotContain("ParametricMidtoneSplit", XmpWriter.Serialize(new XmpSidecarDocument()));
            Assert.DoesNotContain("ParametricHighlightSplit", XmpWriter.Serialize(new XmpSidecarDocument()));

            var doc = new XmpSidecarDocument();
            doc.Adjustments.ParametricShadowSplit = 10;
            doc.Adjustments.ParametricMidtoneSplit = 55.25;
            doc.Adjustments.ParametricHighlightSplit = 90;
            var xml = XmpWriter.Serialize(doc);
            Assert.Contains("crs:ParametricShadowSplit=\"10\"", xml);
            Assert.Contains("crs:ParametricMidtoneSplit=\"55.25\"", xml);
            Assert.Contains("crs:ParametricHighlightSplit=\"90\"", xml);

            // A split left at ITS default stays silent even when a sibling moved.
            var partial = new XmpSidecarDocument();
            partial.Adjustments.ParametricMidtoneSplit = 60;
            var partialXml = XmpWriter.Serialize(partial);
            Assert.Contains("crs:ParametricMidtoneSplit=\"60\"", partialXml);
            Assert.DoesNotContain("ParametricShadowSplit", partialXml);
            Assert.DoesNotContain("ParametricHighlightSplit", partialXml);
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

        /// <summary>
        /// Display-referred point curves (#2232, `crs:ToneCurvePV2012*`) —
        /// same `[0, 1]` model / `[0, 255]` wire contract as the
        /// scene-linear family above, on the sibling `crs:` element.
        /// </summary>
        [Fact]
        public void DisplayToneCurvePointsRescaleToTheWireDomainOnWrite()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.DisplayToneCurveLuma.Add(new CurvePoint(0, 0));
            doc.Adjustments.DisplayToneCurveLuma.Add(new CurvePoint(128 / 255.0, 150 / 255.0));
            doc.Adjustments.DisplayToneCurveLuma.Add(new CurvePoint(1, 1));

            var xml = XmpWriter.Serialize(doc);
            Assert.Contains("<crs:ToneCurvePV2012>", xml);
            Assert.Contains("<rdf:li>128, 150</rdf:li>", xml);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            Assert.Equal(3, parsed!.Adjustments.DisplayToneCurveLuma.Count);
            Assert.Equal(new CurvePoint(128 / 255.0, 150 / 255.0), parsed.Adjustments.DisplayToneCurveLuma[1]);
        }

        [Fact]
        public void BothToneCurveFamiliesCoexistAndEmitInCanonicalOrder()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(0, 0));
            doc.Adjustments.ToneCurveLuma.Add(new CurvePoint(1, 1));
            doc.Adjustments.DisplayToneCurveLuma.Add(new CurvePoint(0, 0));
            doc.Adjustments.DisplayToneCurveLuma.Add(new CurvePoint(1, 1));

            var xml = XmpWriter.Serialize(doc);
            var sceneLinearIndex = xml.IndexOf("<papp:SceneLinearToneCurve>", System.StringComparison.Ordinal);
            var displayIndex = xml.IndexOf("<crs:ToneCurvePV2012>", System.StringComparison.Ordinal);
            Assert.True(sceneLinearIndex >= 0 && displayIndex >= 0);
            Assert.True(sceneLinearIndex < displayIndex, "scene-linear block must precede the display-referred block");

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            Assert.Equal(2, parsed!.Adjustments.ToneCurveLuma.Count);
            Assert.Equal(2, parsed.Adjustments.DisplayToneCurveLuma.Count);
        }

        [Fact]
        public void IdentityDisplayToneCurveEmitsNoElementAtAll()
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument());
            Assert.DoesNotContain("ToneCurvePV2012", xml);
        }
    }
}
