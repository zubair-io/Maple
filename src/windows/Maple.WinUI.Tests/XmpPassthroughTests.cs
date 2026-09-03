// XmpPassthroughTests — unknown attributes and unknown child elements must
// survive a read-modify-write untouched (`docs/xmp-canonical-format.md` §
// "Passthrough"). Mirrors the intent of `XMPPassthroughTests.swift`, scoped
// to what `XmpParser`/`XmpWriter` implement: attribute passthrough (with the
// namespace declaration it needs) and node passthrough, each asserted to
// preserve its own relative order.
//
// `ChildOrderIsPreservedRelativeToModeledToneCurves` (#2671) used to be
// `ChildOrderIsNotPreservedRelativeToModeledToneCurves`, a characterization
// test documenting that `XmpWriter.BuildChildren` unconditionally emitted
// modeled tone-curve blocks before every passthrough node, regardless of
// where they sat in the source document. `XmpSidecarDocument.ChildOrder`
// (populated by `XmpParser.ParseChildren`, consumed by
// `XmpWriter.BuildChildren`) now interleaves passthrough nodes and
// tone-curve blocks back into their original relative order on write, so
// this asserts the fixed, byte-stable position instead.

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
        /// #2671: a real Maple/Lightroom sidecar carrying unmodeled content
        /// (here `dc:subject`, Windows has no keywords field) ahead of a
        /// modeled tone curve must keep that relative order across a
        /// read-modify-write, matching Swift/TS's own fixed keywords-then-
        /// tone-curve position (`xmp-serializer.service.ts`'s child-
        /// ordering comment). `XmpSidecarDocument.ChildOrder` is what makes
        /// this hold for Windows's fully-generic passthrough bucket rather
        /// than a single hard-coded field.
        /// </summary>
        [Fact]
        public void ChildOrderIsPreservedRelativeToModeledToneCurves()
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

            Assert.True(subjectAt < curveAt,
                "#2671: dc:subject sat before the tone curve in the source document and must " +
                "still sit before it after a read-modify-write");
        }

        /// <summary>Mirror of the previous test: the source order can run either way.</summary>
        [Fact]
        public void PassthroughNodeAfterToneCurveKeepsItsPosition()
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
                "      <papp:SceneLinearToneCurve>",
                "        <rdf:Seq>",
                "          <rdf:li>0, 0</rdf:li>",
                "          <rdf:li>255, 255</rdf:li>",
                "        </rdf:Seq>",
                "      </papp:SceneLinearToneCurve>",
                "      <dc:subject>",
                "        <rdf:Bag>",
                "          <rdf:li>alpha</rdf:li>",
                "        </rdf:Bag>",
                "      </dc:subject>",
                "    </rdf:Description>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);
            var resaved = XmpWriter.Serialize(doc!);

            var curveAt = resaved.IndexOf("SceneLinearToneCurve", System.StringComparison.Ordinal);
            var subjectAt = resaved.IndexOf("dc:subject", System.StringComparison.Ordinal);
            Assert.True(curveAt >= 0 && subjectAt >= 0, "both blocks must survive the resave");
            Assert.True(curveAt < subjectAt,
                "#2671: the tone curve sat before dc:subject in the source document and must " +
                "still sit before it after a read-modify-write");
        }

        /// <summary>
        /// A passthrough node sandwiched between two distinct tone-curve
        /// tags must keep its slot relative to BOTH, not just the nearer
        /// one — exercises `ChildOrder` recording more than one recognized
        /// tag rather than treating "the tone curve group" as one unit.
        /// </summary>
        [Fact]
        public void PassthroughNodeBetweenTwoToneCurvesStaysBetweenThem()
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
                "      <papp:SceneLinearToneCurve>",
                "        <rdf:Seq>",
                "          <rdf:li>0, 0</rdf:li>",
                "          <rdf:li>255, 255</rdf:li>",
                "        </rdf:Seq>",
                "      </papp:SceneLinearToneCurve>",
                "      <dc:subject>",
                "        <rdf:Bag>",
                "          <rdf:li>alpha</rdf:li>",
                "        </rdf:Bag>",
                "      </dc:subject>",
                "      <papp:SceneLinearToneCurveRed>",
                "        <rdf:Seq>",
                "          <rdf:li>0, 10</rdf:li>",
                "          <rdf:li>255, 245</rdf:li>",
                "        </rdf:Seq>",
                "      </papp:SceneLinearToneCurveRed>",
                "    </rdf:Description>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);
            var resaved = XmpWriter.Serialize(doc!);

            var lumaAt = resaved.IndexOf("<papp:SceneLinearToneCurve>", System.StringComparison.Ordinal);
            var subjectAt = resaved.IndexOf("dc:subject", System.StringComparison.Ordinal);
            var redAt = resaved.IndexOf("SceneLinearToneCurveRed", System.StringComparison.Ordinal);
            Assert.True(lumaAt >= 0 && subjectAt >= 0 && redAt >= 0, "all three blocks must survive the resave");
            Assert.True(lumaAt < subjectAt && subjectAt < redAt,
                "#2671: dc:subject sat between the two tone-curve tags and must stay between them");
        }

        /// <summary>
        /// A tone curve that was present in the source document but is
        /// cleared to identity before saving (e.g. the user reset it) must
        /// emit nothing at its recorded slot — surrounding passthrough
        /// content keeps its own position rather than leaving a gap or
        /// shifting.
        /// </summary>
        [Fact]
        public void ClearedToneCurveLeavesNoGapAtItsRecordedSlot()
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

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);
            doc!.Adjustments.ToneCurveLuma.Clear();

            var resaved = XmpWriter.Serialize(doc);

            Assert.Contains("dc:subject", resaved);
            Assert.DoesNotContain("SceneLinearToneCurve", resaved);
        }

        /// <summary>
        /// #2671 review (Jules/Copilot): nothing enforced that every
        /// `PassthroughNodes` entry has a matching `ChildOrder` slot before
        /// this PR either, and `PassthroughNodes` is a public settable list
        /// — a caller appending to it directly (bypassing the parser) must
        /// not have that content silently dropped on save just because
        /// `ChildOrder` doesn't know about it. `BuildChildren` falls back to
        /// appending any unvisited entry.
        /// </summary>
        [Fact]
        public void PassthroughNodeAddedWithoutAChildOrderSlotStillSurvivesSave()
        {
            var doc = XmpParser.Parse(DocWithUnknownAttributeAndNode);
            Assert.NotNull(doc);

            // Simulate a caller mutating PassthroughNodes directly, the way
            // nothing in the public API prevented before this PR.
            doc!.PassthroughNodes.Add("<dc:description><rdf:Alt><rdf:li>added later</rdf:li></rdf:Alt></dc:description>");

            var resaved = XmpWriter.Serialize(doc);

            Assert.Contains("<xmpMM:History", resaved);
            Assert.Contains("added later", resaved);
        }

        /// <summary>
        /// #2671 review (Jules): a `ChildOrder` entry naming a tone-curve
        /// tag `XmpSchema.ToneCurveElements` doesn't recognize (stale data,
        /// or a hand-built `XmpSidecarDocument`) must not crash the save —
        /// it is simply skipped, the same as any other unrecognized field.
        /// </summary>
        [Fact]
        public void UnrecognizedToneCurveTagInChildOrderDoesNotThrow()
        {
            var doc = XmpParser.Parse(DocWithUnknownAttributeAndNode);
            Assert.NotNull(doc);
            doc!.ChildOrder.Add(ChildSlot.ForModeled("papp:NotARealToneCurve"));

            var resaved = XmpWriter.Serialize(doc);

            Assert.Contains("<xmpMM:History", resaved);
        }

        /// <summary>
        /// #3113 review (Copilot): a stale/out-of-sync `ChildOrder` that
        /// repeats the same `PassthroughIndex` twice must not duplicate
        /// that node in the output — only the first occurrence emits, the
        /// same defensive posture `BuildChildren` already takes for an
        /// out-of-range or missing index.
        /// </summary>
        [Fact]
        public void DuplicatePassthroughIndexInChildOrderEmitsTheNodeOnlyOnce()
        {
            var doc = XmpParser.Parse(DocWithUnknownAttributeAndNode);
            Assert.NotNull(doc);

            // The parsed document already has one ChildOrder slot pointing
            // at PassthroughIndex 0 (the xmpMM:History node) — append a
            // second slot pointing at the same index, simulating stale data.
            doc!.ChildOrder.Add(ChildSlot.ForPassthrough(0));

            var resaved = XmpWriter.Serialize(doc);

            var firstAt = resaved.IndexOf("<xmpMM:History", System.StringComparison.Ordinal);
            var lastAt = resaved.LastIndexOf("<xmpMM:History", System.StringComparison.Ordinal);
            Assert.True(firstAt >= 0, "the node must still survive the resave");
            Assert.Equal(firstAt, lastAt);
        }

        /// <summary>
        /// Mirror of <see cref="DuplicatePassthroughIndexInChildOrderEmitsTheNodeOnlyOnce"/>
        /// for the other `ChildOrder` slot kind (#3113 review, Copilot):
        /// a stale/out-of-sync `ChildOrder` that repeats the same
        /// tone-curve tag must not duplicate that block in the output —
        /// only the first occurrence emits.
        /// </summary>
        [Fact]
        public void DuplicateToneCurveTagInChildOrderEmitsTheBlockOnlyOnce()
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
                "      crs:HasSettings=\"True\">",
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

            var doc = XmpParser.Parse(xml);
            Assert.NotNull(doc);

            // The parsed document already has one ChildOrder slot for
            // papp:SceneLinearToneCurve — append a second slot for the
            // same tag, simulating stale data.
            doc!.ChildOrder.Add(ChildSlot.ForModeled("papp:SceneLinearToneCurve"));

            var resaved = XmpWriter.Serialize(doc);

            var firstAt = resaved.IndexOf("<papp:SceneLinearToneCurve>", System.StringComparison.Ordinal);
            var lastAt = resaved.LastIndexOf("<papp:SceneLinearToneCurve>", System.StringComparison.Ordinal);
            Assert.True(firstAt >= 0, "the tone-curve block must still survive the resave");
            Assert.Equal(firstAt, lastAt);
        }
    }
}
