// RenderEngineCurveTests — the model → FFI wire contract for point tone
// curves (#3234). raw-ffi's curve entries (`MapleToneCurves` for the fused
// CPU chain, `MapleGpuLiveParams.tone_curve_*` for the live chain) take
// flat `[x0, y0, x1, y1, …]` f32 pairs in `[0, 1]` — raw-core's own XMP
// layer divides the `[0, 255]` wire values by 255 before the model ever
// reaches the pipeline (`raw-core/src/xmp/tone_curves.rs`). Before #3234 the
// Windows parser stored the wire values unscaled and `FlattenCurve` copied
// them straight through, so a Lightroom-authored curve reached the FFI with
// knots up to 255× out of range.

using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RenderEngineCurveTests
    {
        private const string LightroomCurveSidecar = """
            <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description rdf:about=""
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:papp="http://ns.justmaple.app/photo/1.0/"
                  crs:Version="11.0">
                  <crs:ToneCurvePV2012>
                    <rdf:Seq>
                      <rdf:li>0, 0</rdf:li>
                      <rdf:li>64, 48</rdf:li>
                      <rdf:li>192, 205</rdf:li>
                      <rdf:li>255, 255</rdf:li>
                    </rdf:Seq>
                  </crs:ToneCurvePV2012>
                  <papp:SceneLinearToneCurve>
                    <rdf:Seq>
                      <rdf:li>0, 0</rdf:li>
                      <rdf:li>127.5, 140.25</rdf:li>
                      <rdf:li>255, 255</rdf:li>
                    </rdf:Seq>
                  </papp:SceneLinearToneCurve>
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """;

        [Fact]
        public void FlattenedSidecarCurvesStayInsideTheUnitRange()
        {
            var doc = XmpParser.Parse(LightroomCurveSidecar);
            Assert.NotNull(doc);

            var sceneLinear = RenderEngine.FlattenCurve(doc!.Adjustments.ToneCurveLuma);
            var display = RenderEngine.FlattenCurve(doc.Adjustments.DisplayToneCurveLuma);

            Assert.Equal(6, sceneLinear.Length);
            Assert.Equal(8, display.Length);
            Assert.All(sceneLinear.Concat(display), v => Assert.InRange(v, 0f, 1f));

            // The interior knots are the wire values ÷ 255, not the wire values.
            Assert.Equal(0.5, sceneLinear[2], precision: 6);
            Assert.Equal(0.55, sceneLinear[3], precision: 6);
            Assert.Equal(64.0 / 255.0, display[2], precision: 6);
            Assert.Equal(48.0 / 255.0, display[3], precision: 6);
            Assert.Equal(1f, display[6]);
            Assert.Equal(1f, display[7]);
        }

        [Fact]
        public void FlattenInterleavesXAndYPairsInPointOrder()
        {
            var points = new List<CurvePoint> { new(0, 0), new(0.25, 0.15), new(1, 1) };

            var flat = RenderEngine.FlattenCurve(points);

            Assert.Equal(new[] { 0f, 0f, 0.25f, 0.15f, 1f, 1f }, flat);
        }

        [Fact]
        public void IdentityCurveFlattensToAnEmptyArray()
        {
            // Both FFI surfaces read a zero-length list as "no curve".
            Assert.Empty(RenderEngine.FlattenCurve(new List<CurvePoint>()));
        }
    }
}
