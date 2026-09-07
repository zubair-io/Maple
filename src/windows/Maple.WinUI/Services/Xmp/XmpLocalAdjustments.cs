// XmpLocalAdjustments — nested-element XMP I/O for local adjustments (#358):
// the canonical Adobe Camera Raw `crs:GradientBasedCorrections` (linear
// masks) / `crs:CircularGradientBasedCorrections` (radial masks) containers,
// each an `rdf:Seq` of `rdf:li` → `rdf:Description` corrections carrying the
// `crs:Local*2012` sliders and one nested `crs:CorrectionMasks` mask leaf.
// `docs/xmp-canonical-format.md` § "Local adjustments" is the contract;
// `raw-core/src/xmp/local_adjustments/` is the reference implementation this
// mirrors byte-for-byte on the write side and semantically on the read side.
//
// Read-side tolerance matches the rest of `XmpParser` rather than raw-core's
// hard-error posture: a correction whose mask isn't a shape Maple models,
// that is inactive (`CorrectionActive="False"`), or whose required geometry
// is missing or non-numeric is DROPPED — never silently placed at an
// invented 0/1 — and the rest of the document still loads. A corrupt slider
// value on an otherwise valid correction reads as "not set".

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    internal static class XmpLocalAdjustments
    {
        public const string LinearContainer = "crs:GradientBasedCorrections";
        public const string RadialContainer = "crs:CircularGradientBasedCorrections";

        /// <summary>Both containers, in canonical emit order.</summary>
        public static readonly IReadOnlyList<string> ContainerTags = new[] { LinearContainer, RadialContainer };

        private const string MasksLocalName = "CorrectionMasks";
        private const string MaskWhatLinear = "Mask/Gradient";
        private const string MaskWhatRadial = "Mask/CircularGradient";

        private static readonly XNamespace Crs = XmpSchema.CrsNs;
        private static readonly XNamespace Papp = XmpSchema.PappNs;
        private static readonly XNamespace PappLegacy = XmpSchema.PappNsLegacy;

        /// <summary>
        /// Slider attribute ↔ model field, in canonical emit order. Every
        /// field has a direct Adobe key except vibrance: Adobe's local-
        /// correction struct has no vibrance control, so it rides Maple's
        /// own `papp:LocalVibrance`.
        /// </summary>
        private static readonly (string Key, Func<PartialAdjustments, double?> Get,
            Func<PartialAdjustments, double, PartialAdjustments> With)[] Sliders =
        {
            ("crs:LocalExposure2012", p => p.Exposure, (p, v) => p with { Exposure = v }),
            ("crs:LocalContrast2012", p => p.Contrast, (p, v) => p with { Contrast = v }),
            ("crs:LocalHighlights2012", p => p.Highlights, (p, v) => p with { Highlights = v }),
            ("crs:LocalShadows2012", p => p.Shadows, (p, v) => p with { Shadows = v }),
            ("crs:LocalWhites2012", p => p.Whites, (p, v) => p with { Whites = v }),
            ("crs:LocalBlacks2012", p => p.Blacks, (p, v) => p with { Blacks = v }),
            ("crs:LocalSaturation", p => p.Saturation, (p, v) => p with { Saturation = v }),
            ("papp:LocalVibrance", p => p.Vibrance, (p, v) => p with { Vibrance = v }),
            ("crs:LocalTemperature", p => p.Temperature, (p, v) => p with { Temperature = v }),
            ("crs:LocalTint", p => p.Tint, (p, v) => p with { Tint = v }),
            ("crs:LocalHue", p => p.Hue / 100, (p, v) => p with { Hue = v * 100 }),
        };

        /// <summary>The canonical container tag `child` is, or null when it is neither.</summary>
        public static string? ContainerTagFor(XElement child)
        {
            if (XmpSchema.CanonicalPrefixFor(child.Name.NamespaceName) != "crs") return null;
            var qualified = "crs:" + child.Name.LocalName;
            return ContainerTags.Contains(qualified) ? qualified : null;
        }

        // ── Parse ────────────────────────────────────────────────────────────

        /// <summary>RDF structural elements match on local name only, like raw-core's `is_seq` / `is_li`.</summary>
        private static IEnumerable<XElement> ChildrenNamed(XElement el, string local) =>
            el.Elements().Where(e => e.Name.LocalName == local);

        /// <summary>A `prefix:Local` attribute resolved by namespace URI (both papp URIs accepted).</summary>
        private static string? Attr(XElement el, string qualified)
        {
            var colon = qualified.IndexOf(':');
            var local = qualified[(colon + 1)..];
            return qualified[..colon] switch
            {
                "crs" => el.Attribute(Crs + local)?.Value,
                "papp" => (el.Attribute(Papp + local) ?? el.Attribute(PappLegacy + local))?.Value,
                _ => null,
            };
        }

        private static double? Finite(XElement el, string qualified)
        {
            var raw = Attr(el, qualified);
            if (string.IsNullOrWhiteSpace(raw)) return null;
            return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v)
                ? v
                : null;
        }

        /// <summary>Adobe's boolean spellings, case-insensitive; null for anything else.</summary>
        private static bool? XmpBool(string? raw) => raw?.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "on" => true,
            "0" or "false" or "off" => false,
            _ => null,
        };

        private static LocalMask? ParseLinearLeaf(XElement leaf)
        {
            var zx = Finite(leaf, "crs:ZeroX");
            var zy = Finite(leaf, "crs:ZeroY");
            var fx = Finite(leaf, "crs:FullX");
            var fy = Finite(leaf, "crs:FullY");
            if (zx is null || zy is null || fx is null || fy is null) return null;
            return new LinearMask(
                new MaskPoint(zx.Value, zy.Value), new MaskPoint(fx.Value, fy.Value),
                Finite(leaf, "papp:LocalFeather") ?? 0.5);
        }

        private static LocalMask? ParseRadialLeaf(XElement leaf)
        {
            var top = Finite(leaf, "crs:Top");
            var left = Finite(leaf, "crs:Left");
            var bottom = Finite(leaf, "crs:Bottom");
            var right = Finite(leaf, "crs:Right");
            if (top is null || left is null || bottom is null || right is null) return null;
            var featherPct = Finite(leaf, "crs:Feather") ?? 50;
            return new RadialMask(
                new MaskPoint((left.Value + right.Value) / 2, (top.Value + bottom.Value) / 2),
                new MaskPoint((right.Value - left.Value) / 2, (bottom.Value - top.Value) / 2),
                DegreesToRadians(Finite(leaf, "crs:Angle") ?? 0),
                Math.Clamp(featherPct / 100, 0, 1),
                XmpBool(Attr(leaf, "crs:Flipped")) ?? false);
        }

        /// <summary>The first `crs:CorrectionMasks` leaf whose `crs:What` this container models.</summary>
        private static LocalMask? ParseMask(XElement description, bool linear)
        {
            var masks = description.Elements().FirstOrDefault(e =>
                e.Name.LocalName == MasksLocalName && XmpSchema.CanonicalPrefixFor(e.Name.NamespaceName) == "crs");
            var seq = masks is null ? null : ChildrenNamed(masks, "Seq").FirstOrDefault();
            var leaves = seq is null ? Enumerable.Empty<XElement>() : ChildrenNamed(seq, "li");
            var what = linear ? MaskWhatLinear : MaskWhatRadial;
            return leaves
                .Where(leaf => Attr(leaf, "crs:What") == what)
                .Select(leaf => linear ? ParseLinearLeaf(leaf) : ParseRadialLeaf(leaf))
                .FirstOrDefault(mask => mask is not null);
        }

        private static LocalAdjustment? ParseCorrection(XElement description, bool linear)
        {
            // Absent or unrecognized CorrectionActive means active (Adobe's
            // convention); an explicit "False" is a disabled pin and is dropped.
            if (!(XmpBool(Attr(description, "crs:CorrectionActive")) ?? true)) return null;
            var mask = ParseMask(description, linear);
            if (mask is null) return null;
            // CorrectionAmount is Adobe's 0–1 overall-strength dial: it scales
            // every stored slider at parse time, as Adobe's own Amount slider does.
            var amount = Finite(description, "crs:CorrectionAmount") ?? 1;
            var adjustments = Sliders.Aggregate(new PartialAdjustments(), (acc, slider) =>
            {
                var value = Finite(description, slider.Key);
                return value is null ? acc : slider.With(acc, amount == 1 ? value.Value : value.Value * amount);
            });
            return new LocalAdjustment(mask, adjustments, ParseRange(description));
        }

        private static ColorRangeRefinement? ParseRange(XElement description)
        {
            if (Attr(description, "papp:RangeKind") != "Color") return null;
            double? Read(string key, double fallback) =>
                Attr(description, key) is null ? fallback : Finite(description, key);
            var hue = Read("papp:RangeHue", 55);
            var width = Read("papp:RangeHueWidth", 25);
            var chroma = Read("papp:RangeChromaMin", 0.02);
            var min = Read("papp:RangeLMin", 0.15);
            var max = Read("papp:RangeLMax", 0.95);
            var feather = Read("papp:RangeFeather", 0.3);
            return hue is null || width is null || chroma is null || min is null || max is null || feather is null
                ? null : new(hue.Value, width.Value, chroma.Value, min.Value, max.Value, feather.Value);
        }

        private static IEnumerable<string> RangeLines(ColorRangeRefinement? range, string indent)
        {
            if (range is null) return Array.Empty<string>();
            var values = new[] {
                ("RangeHue", range.HueDeg), ("RangeHueWidth", range.HueHalfWidthDeg),
                ("RangeChromaMin", range.ChromaMin), ("RangeLMin", range.LMin),
                ("RangeLMax", range.LMax), ("RangeFeather", range.Feather),
            };
            if (values.Any(v => !double.IsFinite(v.Item2))) return Array.Empty<string>();
            return new[] { $"{indent}papp:RangeKind=\"Color\"" }.Concat(values.Select(v =>
                $"{indent}papp:{v.Item1}=\"{XmpSchema.FormatNumber(v.Item2)}\""));
        }

        /// <summary>
        /// Read one container element's corrections into layers, in document
        /// order. Corrections the reader can't model are dropped (file header).
        /// </summary>
        public static List<LocalAdjustment> Parse(XElement container, string containerTag)
        {
            var linear = containerTag == LinearContainer;
            var seq = ChildrenNamed(container, "Seq").FirstOrDefault();
            if (seq is null) return new List<LocalAdjustment>();
            return ChildrenNamed(seq, "li")
                .Select(li => ChildrenNamed(li, "Description").FirstOrDefault())
                .Where(description => description is not null)
                .Select(description => ParseCorrection(description!, linear))
                .Where(layer => layer is not null)
                .Select(layer => layer!)
                .ToList();
        }

        // ── Serialize ────────────────────────────────────────────────────────

        private static double DegreesToRadians(double degrees) => degrees * Math.PI / 180;
        private static double RadiansToDegrees(double radians) => radians * 180 / Math.PI;

        private static IEnumerable<string> MaskLines(LocalMask mask, string indent)
        {
            var n = (Func<double, string>)XmpSchema.FormatNumber;
            switch (mask)
            {
                case LinearMask l:
                    return new[]
                    {
                        $"{indent}<rdf:li",
                        $"{indent}  crs:What=\"{MaskWhatLinear}\"",
                        $"{indent}  crs:MaskValue=\"1\"",
                        $"{indent}  crs:ZeroX=\"{n(l.Start.X)}\" crs:ZeroY=\"{n(l.Start.Y)}\"",
                        $"{indent}  crs:FullX=\"{n(l.End.X)}\" crs:FullY=\"{n(l.End.Y)}\"",
                        $"{indent}  papp:LocalFeather=\"{n(l.Feather)}\"/>",
                    };
                case RadialMask r:
                    var top = n(r.Center.Y - r.Radii.Y);
                    var left = n(r.Center.X - r.Radii.X);
                    var bottom = n(r.Center.Y + r.Radii.Y);
                    var right = n(r.Center.X + r.Radii.X);
                    return new[]
                    {
                        $"{indent}<rdf:li",
                        $"{indent}  crs:What=\"{MaskWhatRadial}\"",
                        $"{indent}  crs:MaskValue=\"1\"",
                        $"{indent}  crs:Top=\"{top}\" crs:Left=\"{left}\" crs:Bottom=\"{bottom}\" crs:Right=\"{right}\"",
                        $"{indent}  crs:Angle=\"{n(RadiansToDegrees(r.Angle))}\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
                        $"{indent}  crs:Feather=\"{n(r.Feather * 100)}\" crs:Flipped=\"{(r.Invert ? "True" : "False")}\"/>",
                    };
                default:
                    throw new InvalidOperationException($"unknown mask shape {mask.GetType().Name}");
            }
        }

        private static string ContainerBlock(string tag, IReadOnlyList<LocalAdjustment> layers, string indent)
        {
            string Step(int n) => indent + new string(' ', n);
            var (i1, i2, i3, i4, i5, i6) = (Step(2), Step(4), Step(6), Step(8), Step(10), Step(12));
            var layerLines = layers.SelectMany(layer =>
            {
                var attrs = new[]
                    {
                        $"{i4}crs:What=\"Correction\"",
                        $"{i4}crs:CorrectionAmount=\"1\"",
                        $"{i4}crs:CorrectionActive=\"True\"",
                    }
                    .Concat(Sliders
                        // Only fields actually set are written; a non-finite
                        // value is not representable in XMP and is skipped.
                        .Select(s => (s.Key, Value: s.Get(layer.Adjustments)))
                        .Where(s => s.Value is not null && double.IsFinite(s.Value.Value))
                        .Select(s => $"{i4}{s.Key}=\"{XmpSchema.FormatNumber(s.Value!.Value)}\""))
                    .Concat(RangeLines(layer.Range, i4));
                return new[]
                    {
                        $"{i2}<rdf:li>",
                        $"{i3}<rdf:Description",
                        string.Join("\n", attrs) + ">",
                        $"{i4}<crs:CorrectionMasks>",
                        $"{i5}<rdf:Seq>",
                    }
                    .Concat(MaskLines(layer.Mask, i6))
                    .Concat(new[]
                    {
                        $"{i5}</rdf:Seq>",
                        $"{i4}</crs:CorrectionMasks>",
                        $"{i3}</rdf:Description>",
                        $"{i2}</rdf:li>",
                    });
            });
            return string.Join("\n", new[] { $"{indent}<{tag}>", $"{i1}<rdf:Seq>" }
                .Concat(layerLines)
                .Concat(new[] { $"{i1}</rdf:Seq>", $"{indent}</{tag}>" }));
        }

        /// <summary>
        /// One container's block for the layers of its kind, or null when
        /// there are none — "identity is silence", like the tone curves.
        /// </summary>
        public static string? Block(string tag, IReadOnlyList<LocalAdjustment> layers, string indent)
        {
            var linear = tag == LinearContainer;
            var ofKind = layers.Where(l => (l.Mask is LinearMask) == linear).ToList();
            return ofKind.Count == 0 ? null : ContainerBlock(tag, ofKind, indent);
        }

        /// <summary>
        /// Both container blocks for `layers`, each line prefixed so the
        /// container sits at `indent`. Byte-identical to raw-core's
        /// `serialize_local_adjustments`, Swift's `_buildLocalAdjustmentsBlock`
        /// and TypeScript's `localAdjustmentBlocks` for the same layers —
        /// `XmpLocalAdjustmentsTests` pins that against the shared literal.
        /// Adobe keeps linear and radial corrections in two separate arrays,
        /// so an interleaved stack round-trips as two contiguous runs (all
        /// linear, then all radial). Empty when there are no layers.
        /// </summary>
        public static string Serialize(IReadOnlyList<LocalAdjustment> layers, string indent) =>
            string.Join("\n", ContainerTags
                .Select(tag => Block(tag, layers, indent))
                .Where(block => block is not null));
    }
}
