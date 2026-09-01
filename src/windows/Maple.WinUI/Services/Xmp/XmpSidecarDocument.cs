// XmpSidecarDocument — the Windows model of one parsed .xmp sidecar.
//
// Mirrors the TypeScript reference (`src/web/projects/maple-common/src/lib/xmp/`)
// and the canonical contract in `docs/xmp-canonical-format.md`: adjustments,
// culling (rating / flag / color label), version signaling, the WB scale
// stamp, and the passthrough buckets that preserve everything Maple does not
// model across a read-modify-write.

using System;
using System.Collections.Generic;
using System.Globalization;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    /// <summary>One passthrough attribute (`name="value"`, name includes prefix).</summary>
    public readonly record struct XmpAttribute(string Name, string Value);

    /// <summary>One namespace declaration required by passthrough content.</summary>
    public readonly record struct XmpNamespaceDecl(string Prefix, string Uri);

    /// <summary>
    /// One parsed sidecar. Fields Maple models live in <see cref="Adjustments"/>
    /// and the culling properties; everything else the source document carried
    /// rides the passthrough lists and re-emits verbatim on save.
    /// </summary>
    public sealed class XmpSidecarDocument
    {
        public AdjustmentState Adjustments { get; set; } = new();

        /// <summary>`xmp:Rating` 1..5; null = unrated (0 is never written — Adobe convention).</summary>
        public int? Rating { get; set; }

        /// <summary>`papp:Flag` — "pick" / "reject"; null = unflagged (attribute omitted).</summary>
        public string? Flag { get; set; }

        /// <summary>`papp:ColorLabel` — red/orange/yellow/green/blue/purple; null = unset.</summary>
        public string? ColorLabel { get; set; }

        /// <summary>`crs:Version` — imported sidecars retain their original string.</summary>
        public string Version { get; set; } = "11.0";

        /// <summary>`crs:ProcessVersion` — imported sidecars retain their original string.</summary>
        public string ProcessVersion { get; set; } = "11.0";

        /// <summary>
        /// `papp:WbScaleVersion` (#1780/#1875/#1894/#2670). Always 1 or 5 after
        /// parse: a legacy 2/3/4 stamp is upgraded to 5 on load, with
        /// `Temperature`/`Tint` rescaled to the V5 meaning in the same step
        /// (`XmpParser`), so the pair never round-trips in an authored-legacy
        /// scale. Stamp-absent documents take the heuristic result. Re-emitted
        /// as stored whenever an explicit `crs:Temperature`/`crs:Tint` is
        /// written. Fresh documents are the current version, 5.
        /// </summary>
        public int WbScaleVersion { get; set; } = 5;

        /// <summary>Unknown attributes on `rdf:Description`, re-emitted sorted canonically.</summary>
        public List<XmpAttribute> PassthroughAttributes { get; set; } = new();

        /// <summary>Namespace declarations the passthrough attributes need.</summary>
        public List<XmpNamespaceDecl> PassthroughNamespaces { get; set; } = new();

        /// <summary>Unknown child elements of `rdf:Description`, verbatim XML, source order.</summary>
        public List<string> PassthroughNodes { get; set; } = new();

        /// <summary>Siblings of `rdf:Description` inside `rdf:RDF`, verbatim XML.</summary>
        public List<string> PassthroughRdfNodes { get; set; } = new();

        /// <summary>Siblings of `rdf:RDF` inside `x:xmpmeta`, verbatim XML.</summary>
        public List<string> PassthroughXmpmetaNodes { get; set; } = new();
    }

    /// <summary>One numeric adjustment field: XMP key plus model accessors.</summary>
    internal sealed record XmpNumericField(
        string Key,
        Func<AdjustmentState, double> Get,
        Action<AdjustmentState, double> Set);

    /// <summary>
    /// Shared schema: field table, namespace URIs, canonical-prefix mapping,
    /// number codec and XML escaping. Single source for parser + writer so the
    /// two cannot drift.
    /// </summary>
    internal static class XmpSchema
    {
        public const string RdfNs = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
        public const string XNs = "adobe:ns:meta/";
        public const string XmpNs = "http://ns.adobe.com/xap/1.0/";
        public const string CrsNs = "http://ns.adobe.com/camera-raw-settings/1.0/";
        public const string PappNs = "http://ns.justmaple.app/photo/1.0/";
        public const string PappNsLegacy = "http://ns.justmaple.app/1.0/";
        public const string MapleNs = "https://maple.app/ns/1.0/";
        public const string XmlnsNs = "http://www.w3.org/2000/xmlns/";

        /// <summary>Recognized prefix → URIs (first entry is canonical). Mirrors `xmp-dom-utils.ts`.</summary>
        public static readonly IReadOnlyList<(string Prefix, string[] Uris)> KnownNamespaces = new[]
        {
            ("rdf", new[] { RdfNs }),
            ("xmp", new[] { XmpNs }),
            ("crs", new[] { CrsNs }),
            ("papp", new[] { PappNs, PappNsLegacy }),
            ("maple", new[] { MapleNs }),
            ("dc", new[] { "http://purl.org/dc/elements/1.1/" }),
            ("exif", new[] { "http://ns.adobe.com/exif/1.0/" }),
            ("photoshop", new[] { "http://ns.adobe.com/photoshop/1.0/" }),
            ("Iptc4xmpCore", new[] { "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" }),
            ("xmpRights", new[] { "http://ns.adobe.com/xap/1.0/rights/" }),
        };

        /// <summary>Canonical prefix for a namespace URI, or null when unrecognized.</summary>
        public static string? CanonicalPrefixFor(string uri)
        {
            foreach (var (prefix, uris) in KnownNamespaces)
            {
                if (Array.IndexOf(uris, uri) >= 0) return prefix;
            }
            return null;
        }

        public static bool IsPappUri(string uri) => uri == PappNs || uri == PappNsLegacy;

        /// <summary>
        /// Attribute sort rank (`docs/xmp-canonical-format.md` § "Attribute
        /// ordering"): namespace priority, unknown namespaces last.
        /// </summary>
        public static int PrefixPriority(string qualifiedName)
        {
            var colon = qualifiedName.IndexOf(':');
            if (colon < 0) return 500;
            return qualifiedName[..colon] switch
            {
                "xmp" => 0,
                "crs" => 1,
                "papp" => 2,
                "dc" => 3,
                "exif" => 4,
                "photoshop" => 5,
                "Iptc4xmpCore" => 6,
                "xmpRights" => 7,
                _ => 500,
            };
        }

        /// <summary>
        /// Canonical numeric wire codec (`numericSerializer` in TS,
        /// `XMPSerializer.fmtNum` in Swift): integers bare, non-integers
        /// rounded to two decimals with trailing zeros dropped. Rounding is
        /// half-toward-positive-infinity to match JavaScript's `Math.round`.
        /// </summary>
        public static string FormatNumber(double v)
        {
            if (!double.IsFinite(v)) return "0";
            if (v == Math.Floor(v) && Math.Abs(v) < 1e15)
            {
                return ((long)v).ToString(CultureInfo.InvariantCulture);
            }
            var rounded = Math.Floor(v * 100.0 + 0.5) / 100.0;
            return rounded == Math.Floor(rounded)
                ? ((long)rounded).ToString(CultureInfo.InvariantCulture)
                : rounded.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>Attribute-value escaping: `&amp;`, `&lt;`, `&gt;`, `&quot;`.</summary>
        public static string EscapeAttr(string value) => value
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;")
            .Replace("\"", "&quot;");

        /// <summary>Element-text escaping for `rdf:li` content: `&amp;`, `&lt;`, `&gt;`.</summary>
        public static string EscapeText(string value) => value
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;");

        private static XmpNumericField F(
            string key, Func<AdjustmentState, double> get, Action<AdjustmentState, double> set) =>
            new(key, get, set);

        /// <summary>Canonical defaults — the omit-on-write sentinel for every numeric field.</summary>
        public static readonly AdjustmentState Defaults = new();

        /// <summary>
        /// Numeric field table, mirroring `ADJUSTMENT_FIELDS` in `xmp-fields.ts`
        /// (same keys, same model mapping). Emit order is irrelevant — the
        /// writer sorts attributes canonically.
        /// </summary>
        public static readonly IReadOnlyList<XmpNumericField> NumericFields = new[]
        {
            F("crs:Temperature", a => a.Temperature, (a, v) => a.Temperature = v),
            F("crs:Tint", a => a.Tint, (a, v) => a.Tint = v),
            F("crs:Exposure2012", a => a.Exposure, (a, v) => a.Exposure = v),
            F("papp:Brightness", a => a.Brightness, (a, v) => a.Brightness = v),
            F("crs:Contrast2012", a => a.Contrast, (a, v) => a.Contrast = v),
            F("crs:Highlights2012", a => a.Highlights, (a, v) => a.Highlights = v),
            F("crs:Shadows2012", a => a.Shadows, (a, v) => a.Shadows = v),
            F("crs:Whites2012", a => a.Whites, (a, v) => a.Whites = v),
            F("crs:Blacks2012", a => a.Blacks, (a, v) => a.Blacks = v),
            F("crs:ParametricHighlights", a => a.ParametricHighlights, (a, v) => a.ParametricHighlights = v),
            F("crs:ParametricLights", a => a.ParametricLights, (a, v) => a.ParametricLights = v),
            F("crs:ParametricDarks", a => a.ParametricDarks, (a, v) => a.ParametricDarks = v),
            F("crs:ParametricShadows", a => a.ParametricShadows, (a, v) => a.ParametricShadows = v),
            F("crs:Vibrance", a => a.Vibrance, (a, v) => a.Vibrance = v),
            F("crs:Saturation", a => a.Saturation, (a, v) => a.Saturation = v),
            F("crs:Clarity2012", a => a.Clarity, (a, v) => a.Clarity = v),
            F("crs:Texture", a => a.Texture, (a, v) => a.Texture = v),
            F("crs:Dehaze", a => a.Dehaze, (a, v) => a.Dehaze = v),
            F("crs:Sharpness", a => a.SharpenAmount, (a, v) => a.SharpenAmount = v),
            F("crs:SharpenRadius", a => a.SharpenRadius, (a, v) => a.SharpenRadius = v),
            F("crs:SharpenDetail", a => a.SharpenDetail, (a, v) => a.SharpenDetail = v),
            F("crs:SharpenEdgeMasking", a => a.SharpenMasking, (a, v) => a.SharpenMasking = v),
            F("papp:CaptureSharpeningAmount", a => a.CaptureSharpeningAmount, (a, v) => a.CaptureSharpeningAmount = v),
            F("papp:CaptureSharpeningSigma", a => a.CaptureSharpeningSigma, (a, v) => a.CaptureSharpeningSigma = v),
            F("crs:LuminanceSmoothing", a => a.NrLuminance, (a, v) => a.NrLuminance = v),
            F("crs:ColorNoiseReduction", a => a.NrColor, (a, v) => a.NrColor = v),
            F("papp:ChromaPrefilter", a => a.ChromaPrefilter, (a, v) => a.ChromaPrefilter = v),
            F("papp:DeepDenoise", a => a.DeepDenoise, (a, v) => a.DeepDenoise = v),
            F("crs:PostCropVignetteAmount", a => a.VignetteAmount, (a, v) => a.VignetteAmount = v),
            F("crs:PostCropVignetteFeather", a => a.VignetteFeather, (a, v) => a.VignetteFeather = v),
            F("crs:GrainAmount", a => a.GrainAmount, (a, v) => a.GrainAmount = v),
            F("crs:GrainSize", a => a.GrainSize, (a, v) => a.GrainSize = v),
            F("crs:GrainFrequency", a => a.GrainRoughness, (a, v) => a.GrainRoughness = v),
            F("crs:SplitToningShadowHue", a => a.SplitToneShadowHue, (a, v) => a.SplitToneShadowHue = v),
            F("crs:SplitToningShadowSaturation", a => a.SplitToneShadowSaturation, (a, v) => a.SplitToneShadowSaturation = v),
            F("crs:SplitToningHighlightHue", a => a.SplitToneHighlightHue, (a, v) => a.SplitToneHighlightHue = v),
            F("crs:SplitToningHighlightSaturation", a => a.SplitToneHighlightSaturation, (a, v) => a.SplitToneHighlightSaturation = v),
            F("crs:SplitToningBalance", a => a.SplitToneBalance, (a, v) => a.SplitToneBalance = v),
            F("crs:ColorGradeShadowLum", a => a.ColorGradeShadowLuminance, (a, v) => a.ColorGradeShadowLuminance = v),
            F("crs:ColorGradeMidtoneHue", a => a.ColorGradeMidtoneHue, (a, v) => a.ColorGradeMidtoneHue = v),
            F("crs:ColorGradeMidtoneSat", a => a.ColorGradeMidtoneSaturation, (a, v) => a.ColorGradeMidtoneSaturation = v),
            F("crs:ColorGradeMidtoneLum", a => a.ColorGradeMidtoneLuminance, (a, v) => a.ColorGradeMidtoneLuminance = v),
            F("crs:ColorGradeHighlightLum", a => a.ColorGradeHighlightLuminance, (a, v) => a.ColorGradeHighlightLuminance = v),
            F("crs:ColorGradeGlobalHue", a => a.ColorGradeGlobalHue, (a, v) => a.ColorGradeGlobalHue = v),
            F("crs:ColorGradeGlobalSat", a => a.ColorGradeGlobalSaturation, (a, v) => a.ColorGradeGlobalSaturation = v),
            F("crs:ColorGradeGlobalLum", a => a.ColorGradeGlobalLuminance, (a, v) => a.ColorGradeGlobalLuminance = v),
            F("crs:HueAdjustmentRed", a => a.HueAdjustmentRed, (a, v) => a.HueAdjustmentRed = v),
            F("crs:HueAdjustmentOrange", a => a.HueAdjustmentOrange, (a, v) => a.HueAdjustmentOrange = v),
            F("crs:HueAdjustmentYellow", a => a.HueAdjustmentYellow, (a, v) => a.HueAdjustmentYellow = v),
            F("crs:HueAdjustmentGreen", a => a.HueAdjustmentGreen, (a, v) => a.HueAdjustmentGreen = v),
            F("crs:HueAdjustmentAqua", a => a.HueAdjustmentAqua, (a, v) => a.HueAdjustmentAqua = v),
            F("crs:HueAdjustmentBlue", a => a.HueAdjustmentBlue, (a, v) => a.HueAdjustmentBlue = v),
            F("crs:HueAdjustmentPurple", a => a.HueAdjustmentPurple, (a, v) => a.HueAdjustmentPurple = v),
            F("crs:HueAdjustmentMagenta", a => a.HueAdjustmentMagenta, (a, v) => a.HueAdjustmentMagenta = v),
            F("crs:SaturationAdjustmentRed", a => a.SaturationAdjustmentRed, (a, v) => a.SaturationAdjustmentRed = v),
            F("crs:SaturationAdjustmentOrange", a => a.SaturationAdjustmentOrange, (a, v) => a.SaturationAdjustmentOrange = v),
            F("crs:SaturationAdjustmentYellow", a => a.SaturationAdjustmentYellow, (a, v) => a.SaturationAdjustmentYellow = v),
            F("crs:SaturationAdjustmentGreen", a => a.SaturationAdjustmentGreen, (a, v) => a.SaturationAdjustmentGreen = v),
            F("crs:SaturationAdjustmentAqua", a => a.SaturationAdjustmentAqua, (a, v) => a.SaturationAdjustmentAqua = v),
            F("crs:SaturationAdjustmentBlue", a => a.SaturationAdjustmentBlue, (a, v) => a.SaturationAdjustmentBlue = v),
            F("crs:SaturationAdjustmentPurple", a => a.SaturationAdjustmentPurple, (a, v) => a.SaturationAdjustmentPurple = v),
            F("crs:SaturationAdjustmentMagenta", a => a.SaturationAdjustmentMagenta, (a, v) => a.SaturationAdjustmentMagenta = v),
            F("crs:LuminanceAdjustmentRed", a => a.LuminanceAdjustmentRed, (a, v) => a.LuminanceAdjustmentRed = v),
            F("crs:LuminanceAdjustmentOrange", a => a.LuminanceAdjustmentOrange, (a, v) => a.LuminanceAdjustmentOrange = v),
            F("crs:LuminanceAdjustmentYellow", a => a.LuminanceAdjustmentYellow, (a, v) => a.LuminanceAdjustmentYellow = v),
            F("crs:LuminanceAdjustmentGreen", a => a.LuminanceAdjustmentGreen, (a, v) => a.LuminanceAdjustmentGreen = v),
            F("crs:LuminanceAdjustmentAqua", a => a.LuminanceAdjustmentAqua, (a, v) => a.LuminanceAdjustmentAqua = v),
            F("crs:LuminanceAdjustmentBlue", a => a.LuminanceAdjustmentBlue, (a, v) => a.LuminanceAdjustmentBlue = v),
            F("crs:LuminanceAdjustmentPurple", a => a.LuminanceAdjustmentPurple, (a, v) => a.LuminanceAdjustmentPurple = v),
            F("crs:LuminanceAdjustmentMagenta", a => a.LuminanceAdjustmentMagenta, (a, v) => a.LuminanceAdjustmentMagenta = v),
            F("crs:GrayMixerRed", a => a.GrayMixerRed, (a, v) => a.GrayMixerRed = v),
            F("crs:GrayMixerOrange", a => a.GrayMixerOrange, (a, v) => a.GrayMixerOrange = v),
            F("crs:GrayMixerYellow", a => a.GrayMixerYellow, (a, v) => a.GrayMixerYellow = v),
            F("crs:GrayMixerGreen", a => a.GrayMixerGreen, (a, v) => a.GrayMixerGreen = v),
            F("crs:GrayMixerAqua", a => a.GrayMixerAqua, (a, v) => a.GrayMixerAqua = v),
            F("crs:GrayMixerBlue", a => a.GrayMixerBlue, (a, v) => a.GrayMixerBlue = v),
            F("crs:GrayMixerPurple", a => a.GrayMixerPurple, (a, v) => a.GrayMixerPurple = v),
            F("crs:GrayMixerMagenta", a => a.GrayMixerMagenta, (a, v) => a.GrayMixerMagenta = v),
            F("crs:LensProfileDistortionScale", a => a.LensCorrectionDistortion, (a, v) => a.LensCorrectionDistortion = v),
            F("crs:LensProfileChromaticAberrationScale", a => a.LensCorrectionCa, (a, v) => a.LensCorrectionCa = v),
            F("crs:LensProfileVignettingScale", a => a.LensCorrectionVignetting, (a, v) => a.LensCorrectionVignetting = v),
        };

        /// <summary>Point-curve element tags in canonical emit order (#365).</summary>
        public static readonly IReadOnlyList<(string Tag, Func<AdjustmentState, List<CurvePoint>> Curve)> ToneCurveElements =
            new (string, Func<AdjustmentState, List<CurvePoint>>)[]
            {
                ("papp:SceneLinearToneCurve", a => a.ToneCurveLuma),
                ("papp:SceneLinearToneCurveRed", a => a.ToneCurveRed),
                ("papp:SceneLinearToneCurveGreen", a => a.ToneCurveGreen),
                ("papp:SceneLinearToneCurveBlue", a => a.ToneCurveBlue),
            };

        /// <summary>The six-color label vocabulary (#1657).</summary>
        public static readonly IReadOnlyList<string> ColorLabels =
            new[] { "red", "orange", "yellow", "green", "blue", "purple" };
    }
}
