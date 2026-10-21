using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class ColorCurveXmpTests
{
    private static readonly string[] NewKeys =
    {
        "papp:ColorCurveHueVsHue", "papp:ColorCurveHueVsSat", "papp:ColorCurveHueVsLuma",
        "papp:ColorCurveLumaVsSat", "papp:ColorCurveSatVsSat", "papp:ColorCurveSatVsLuma",
        "papp:ColorGradeBlending", "papp:ColorGradeShadowEdge", "papp:ColorGradeHighlightEdge",
        "papp:ToneCurveMode",
    };

    // Byte-parity fixture: the same block is asserted in the Rust, Swift and TS suites.
    private static readonly string CanonicalBlock = string.Join("\n", new[]
    {
        "      <papp:ColorCurveHueVsSat>",
        "        <rdf:Seq>",
        "          <rdf:li>0, 128</rdf:li>",
        "          <rdf:li>85, 191</rdf:li>",
        "          <rdf:li>255, 128</rdf:li>",
        "        </rdf:Seq>",
        "      </papp:ColorCurveHueVsSat>",
    });

    private static List<CurvePoint> CanonicalPoints() => new()
    {
        new(0, 128.0 / 255.0), new(85.0 / 255.0, 191.0 / 255.0), new(1, 128.0 / 255.0),
    };

    private static AdjustmentState Edited() => new()
    {
        ColorCurveHueVsHue = new() { new(0, 0.5), new(0.5, 0.75), new(1, 0.5) },
        ColorCurveHueVsSat = CanonicalPoints(),
        ColorCurveHueVsLuma = new() { new(0.2, 0.4), new(0.6, 0.6) },
        ColorCurveLumaVsSat = new() { new(0, 0.5), new(1, 0.8) },
        ColorCurveSatVsSat = new() { new(0, 0), new(1, 0.9) },
        ColorCurveSatVsLuma = new() { new(0.1, 0.5), new(0.9, 0.3) },
        ColorGradeBlending = 40,
        ColorGradeShadowEdge = 0.3,
        ColorGradeHighlightEdge = 0.7,
        ToneCurveMode = ToneCurveMode.RatioPreserving,
    };

    private static void AssertCurve(List<CurvePoint> got, List<CurvePoint> want, string label)
    {
        Assert.Equal(want.Count, got.Count);
        foreach (var (g, w) in got.Zip(want))
        {
            Assert.InRange(Math.Abs(g.X - w.X), 0, 1.0 / 255.0);
            Assert.InRange(Math.Abs(g.Y - w.Y), 0, 1.0 / 255.0);
        }
    }

    [Fact]
    public void CanonicalBlockIsTheSerializationOfAHueVsSatCurve()
    {
        var xml = XmpWriter.Serialize(new() { Adjustments = new() { ColorCurveHueVsSat = CanonicalPoints() } });
        Assert.Contains(CanonicalBlock, xml);
    }

    [Fact]
    public void EveryNewFieldRoundTripsThroughTheSidecar()
    {
        var model = Edited();
        var back = XmpParser.Parse(XmpWriter.Serialize(new() { Adjustments = model }))!.Adjustments;
        AssertCurve(back.ColorCurveHueVsHue, model.ColorCurveHueVsHue, "hue vs hue");
        AssertCurve(back.ColorCurveHueVsSat, model.ColorCurveHueVsSat, "hue vs sat");
        AssertCurve(back.ColorCurveHueVsLuma, model.ColorCurveHueVsLuma, "hue vs luma");
        AssertCurve(back.ColorCurveLumaVsSat, model.ColorCurveLumaVsSat, "luma vs sat");
        AssertCurve(back.ColorCurveSatVsSat, model.ColorCurveSatVsSat, "sat vs sat");
        AssertCurve(back.ColorCurveSatVsLuma, model.ColorCurveSatVsLuma, "sat vs luma");
        Assert.Equal(40, back.ColorGradeBlending);
        Assert.Equal(0.3, back.ColorGradeShadowEdge, 6);
        Assert.Equal(0.7, back.ColorGradeHighlightEdge, 6);
        Assert.Equal(ToneCurveMode.RatioPreserving, back.ToneCurveMode);
    }

    [Fact]
    public void ADefaultModelSerializesNoneOfTheNewFields()
    {
        var xml = XmpWriter.Serialize(new());
        foreach (var key in NewKeys)
            Assert.DoesNotContain(key, xml);
    }

    [Fact]
    public void ASidecarWrittenBeforeTheFieldsExistedParsesToTheDefaults()
    {
        var old = XmpWriter.Serialize(new() { Adjustments = new() { Brightness = 12 } });
        var model = XmpParser.Parse(old)!.Adjustments;
        var defaults = new AdjustmentState();
        Assert.Equal(12, model.Brightness);
        Assert.Empty(model.ColorCurveHueVsHue);
        Assert.Empty(model.ColorCurveHueVsSat);
        Assert.Empty(model.ColorCurveHueVsLuma);
        Assert.Empty(model.ColorCurveLumaVsSat);
        Assert.Empty(model.ColorCurveSatVsSat);
        Assert.Empty(model.ColorCurveSatVsLuma);
        Assert.Equal(defaults.ColorGradeBlending, model.ColorGradeBlending);
        Assert.Equal(defaults.ColorGradeShadowEdge, model.ColorGradeShadowEdge);
        Assert.Equal(defaults.ColorGradeHighlightEdge, model.ColorGradeHighlightEdge);
        Assert.Equal(defaults.ToneCurveMode, model.ToneCurveMode);
    }

    [Fact]
    public void ASingleEditEmitsOnlyItsOwnNewKey()
    {
        var xml = XmpWriter.Serialize(new() { Adjustments = new() { ColorGradeBlending = 40 } });
        Assert.Contains("papp:ColorGradeBlending", xml);
        foreach (var key in NewKeys.Where(k => k != "papp:ColorGradeBlending"))
            Assert.DoesNotContain(key, xml);
    }
}
