// XmpParser — permissive sidecar reader for the Windows shell.
//
// Mirrors the TypeScript reference (`xmp-parser.service.ts` + helpers):
// attributes resolve by namespace URI + local name (never by a spoofable
// source prefix), unknown attributes and nested elements are captured for
// passthrough, missing keys take the canonical defaults, and the
// capture-sharpening sigma / Profile-over-Look precedence rules are
// source-order independent.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    public static class XmpParser
    {
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;

        /// <summary>Attributes Maple models (consumed on read, rebuilt on write — never passthrough).</summary>
        private static readonly HashSet<string> ConsumedAttributes = BuildConsumedAttributes();

        private static readonly Dictionary<string, XmpNumericField> NumericByKey =
            XmpSchema.NumericFields.ToDictionary(f => f.Key);

        private static HashSet<string> BuildConsumedAttributes()
        {
            var names = new HashSet<string>(XmpSchema.NumericFields.Select(f => f.Key))
            {
                "papp:CaptureSharpeningRadius", // legacy read-only alias (#456/#464)
                "papp:WbScaleVersion",
                "crs:Version", "crs:ProcessVersion", "crs:HasSettings",
                "papp:HighlightRecoveryMode", "papp:AutoExposure",
                "papp:Look", "papp:Profile",
                "papp:HotPixelSuppression", "crs:LensProfileEnable",
                "papp:WbMethod", "papp:ToneCurveMode", "crs:ConvertToGrayscale",
                "crs:HasCrop", "crs:CropTop", "crs:CropLeft", "crs:CropBottom",
                "crs:CropRight", "crs:CropAngle", "crs:CropConstrainToWarp",
                "xmp:Rating", "Rating",
                "papp:Flag", "maple:Flag", "Flag",
                "papp:ColorLabel", "maple:ColorLabel", "ColorLabel",
                "xmp:Label", "Label",
                "rdf:about",
            };
            return names;
        }

        /// <summary>
        /// Parse a sidecar. Returns null when the text is not well-formed XML
        /// or carries no `rdf:RDF`/`rdf:Description`; otherwise a document
        /// where every absent field holds its canonical default.
        /// </summary>
        public static XmpSidecarDocument? Parse(string xml)
        {
            XDocument source;
            try
            {
                source = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
            }
            catch (Exception)
            {
                return null;
            }

            var rdf = source.Descendants(Rdf + "RDF").FirstOrDefault();
            var descriptions = rdf?.Elements(Rdf + "Description").ToList();
            if (rdf is null || descriptions is null || descriptions.Count == 0) return null;

            var primary = descriptions
                .OrderByDescending(ManagedNodeCount)
                .First();

            var doc = new XmpSidecarDocument();
            var sawPapp = DocumentCarriesPappNamespace(source);
            ParseAttributes(primary, doc, sawPapp);
            ParseChildren(primary, doc);
            CollectSiblingPassthrough(rdf, primary, doc);
            return doc;
        }

        // ── Attribute walk ──────────────────────────────────────────────────

        private static void ParseAttributes(XElement desc, XmpSidecarDocument doc, bool sawPapp)
        {
            var state = doc.Adjustments;
            var applied = new HashSet<string>();
            var namespaceDecls = new Dictionary<string, string>();
            string? legacySigma = null;
            int? wbStamp = null;
            var profileSeen = false;
            string? flagMaple = null, flagPapp = null, flagPlain = null;
            string? labelMaple = null, labelPapp = null, labelPlain = null, xmpLabel = null;
            var hasCrop = false;
            double cropTop = 0, cropLeft = 0, cropBottom = 1, cropRight = 1, cropAngle = 0;

            foreach (var attr in desc.Attributes())
            {
                if (attr.IsNamespaceDeclaration) continue;
                var name = CanonicalName(attr);
                if (name is null || name == "rdf:about")
                {
                    if (name != "rdf:about") CapturePassthroughAttribute(desc, attr, doc, namespaceDecls);
                    continue;
                }

                if (NumericByKey.TryGetValue(name, out var field))
                {
                    if (TryParseDouble(attr.Value, out var v))
                    {
                        field.Set(state, v);
                        applied.Add(name);
                    }
                    continue;
                }

                switch (name)
                {
                    case "papp:CaptureSharpeningRadius": legacySigma = attr.Value; break;
                    case "crs:Version": doc.Version = attr.Value; break;
                    case "crs:ProcessVersion": doc.ProcessVersion = attr.Value; break;
                    case "crs:HasSettings": break;
                    case "papp:WbScaleVersion":
                        if (int.TryParse(attr.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var stamp))
                            wbStamp = stamp;
                        break;
                    case "papp:HighlightRecoveryMode":
                        Apply(ParseHighlightRecovery(attr.Value), m => state.HighlightRecovery = m);
                        break;
                    case "papp:AutoExposure":
                        Apply(ParseToggle(attr.Value), m => state.AutoExposure = m);
                        break;
                    case "papp:HotPixelSuppression":
                        Apply(ParseToggle(attr.Value), m => state.HotPixelSuppression = m);
                        break;
                    case "papp:Look":
                        ParseLook(attr.Value, state, ref profileSeen);
                        break;
                    case "papp:Profile":
                        profileSeen = true;
                        state.Profile = attr.Value.Equals("Neutral", StringComparison.OrdinalIgnoreCase)
                            ? ProfileMode.Neutral
                            : ProfileMode.Auto;
                        break;
                    case "crs:LensProfileEnable":
                        Apply(ParseOnOffBool(attr.Value), m => state.LensProfileEnable = m);
                        break;
                    case "papp:WbMethod":
                        Apply(ParseWbMethod(attr.Value), m => state.WbMethod = m);
                        break;
                    case "papp:ToneCurveMode":
                        Apply(ParseToneCurveMode(attr.Value), m => state.ToneCurveMode = m);
                        break;
                    case "crs:ConvertToGrayscale":
                        Apply(ParseTrueFalse(attr.Value), m => state.BlackWhite = m);
                        break;
                    // Crop (#2582): the rect is gated on crs:HasCrop (applied
                    // after the walk — attribute order is not guaranteed);
                    // the angle applies unconditionally (pure straighten).
                    case "crs:HasCrop":
                        hasCrop = attr.Value.Equals("True", StringComparison.OrdinalIgnoreCase);
                        break;
                    case "crs:CropTop":
                        if (TryParseDouble(attr.Value, out var ct)) cropTop = ct;
                        break;
                    case "crs:CropLeft":
                        if (TryParseDouble(attr.Value, out var cl)) cropLeft = cl;
                        break;
                    case "crs:CropBottom":
                        if (TryParseDouble(attr.Value, out var cb)) cropBottom = cb;
                        break;
                    case "crs:CropRight":
                        if (TryParseDouble(attr.Value, out var cr)) cropRight = cr;
                        break;
                    case "crs:CropAngle":
                        if (TryParseDouble(attr.Value, out var ca)) cropAngle = ca;
                        break;
                    case "crs:CropConstrainToWarp":
                        break;  // accepted, not stored (canonical format doc)
                    case "xmp:Rating":
                    case "Rating":
                        doc.Rating = ParseRating(attr.Value) ?? doc.Rating;
                        break;
                    case "maple:Flag": flagMaple = attr.Value; break;
                    case "papp:Flag": flagPapp = attr.Value; break;
                    case "Flag": flagPlain = attr.Value; break;
                    case "maple:ColorLabel": labelMaple = attr.Value; break;
                    case "papp:ColorLabel": labelPapp = attr.Value; break;
                    case "ColorLabel": labelPlain = attr.Value; break;
                    case "xmp:Label":
                    case "Label":
                        xmpLabel = attr.Value;
                        break;
                    default:
                        CapturePassthroughAttribute(desc, attr, doc, namespaceDecls);
                        break;
                }
            }

            // Crop: rect only when crs:HasCrop said so and it is valid;
            // an invalid rect degrades to identity (raw-core contract).
            var crop = new CropState(
                hasCrop ? cropTop : 0, hasCrop ? cropLeft : 0,
                hasCrop ? cropBottom : 1, hasCrop ? cropRight : 1, cropAngle);
            state.Crop = hasCrop && !crop.RectIsValid
                ? CropState.Identity with { Angle = cropAngle }
                : crop;

            // Legacy capture-sharpening alias: sigma always wins (#456/#464).
            if (legacySigma is not null && !applied.Contains("papp:CaptureSharpeningSigma") &&
                TryParseDouble(legacySigma, out var sigma))
            {
                state.CaptureSharpeningSigma = sigma;
            }

            // Culling precedence mirrors the web parser: maple: > papp: > unprefixed.
            doc.Flag = ValidFlag(flagMaple) ?? ValidFlag(flagPapp) ?? ValidFlag(flagPlain);
            doc.ColorLabel =
                ValidColorLabel(labelMaple) ?? ValidColorLabel(labelPapp) ?? ValidColorLabel(labelPlain)
                ?? ColorLabelFromXmpLabel(xmpLabel);

            // WB scale (#1780): explicit stamp wins; otherwise a Maple-authored
            // document with an explicit Temperature/Tint predates versioning (1),
            // everything else is current (5).
            var tempOrTint = applied.Contains("crs:Temperature") || applied.Contains("crs:Tint");
            doc.WbScaleVersion = wbStamp ?? (sawPapp && tempOrTint ? 1 : 5);
        }

        private static void CapturePassthroughAttribute(
            XElement desc, XAttribute attr, XmpSidecarDocument doc, Dictionary<string, string> decls)
        {
            var ns = attr.Name.NamespaceName;
            var local = attr.Name.LocalName;
            string name;
            string? declaredUri = null;
            if (ns.Length == 0)
            {
                name = local;
            }
            else if (XmpSchema.CanonicalPrefixFor(ns) is { } canonical)
            {
                name = $"{canonical}:{local}";
                declaredUri = ns;
            }
            else
            {
                var sourcePrefix = desc.GetPrefixOfNamespace(attr.Name.Namespace) ?? "pt";
                var conflicts = XmpSchema.KnownNamespaces.Any(n => n.Prefix == sourcePrefix);
                var prefix = conflicts ? $"passthrough_{sourcePrefix}" : sourcePrefix;
                name = $"{prefix}:{local}";
                declaredUri = ns;
            }
            doc.PassthroughAttributes.Add(new XmpAttribute(name, attr.Value));

            // Record the declaration the writer must emit. The core three
            // (xmp/crs/papp) are always declared by the canonical prelude.
            var colonPrefix = name.Contains(':') ? name[..name.IndexOf(':')] : null;
            if (colonPrefix is null || colonPrefix is "xmp" or "crs" or "papp" || declaredUri is null) return;
            if (!decls.ContainsKey(colonPrefix))
            {
                decls[colonPrefix] = declaredUri;
                doc.PassthroughNamespaces.Add(new XmpNamespaceDecl(colonPrefix, declaredUri));
            }
        }

        // ── Children ────────────────────────────────────────────────────────

        private static void ParseChildren(XElement desc, XmpSidecarDocument doc)
        {
            foreach (var child in desc.Elements())
            {
                var curve = ToneCurveFor(child, doc.Adjustments);
                if (curve is not null)
                {
                    curve.Clear();
                    curve.AddRange(ParseCurvePoints(child));
                    continue;
                }
                doc.PassthroughNodes.Add(child.ToString(SaveOptions.DisableFormatting));
            }
        }

        private static List<CurvePoint>? ToneCurveFor(XElement child, AdjustmentState state)
        {
            if (!XmpSchema.IsPappUri(child.Name.NamespaceName)) return null;
            var qualified = $"papp:{child.Name.LocalName}";
            return XmpSchema.ToneCurveElements
                .Where(e => e.Tag == qualified)
                .Select(e => e.Curve(state))
                .FirstOrDefault();
        }

        private static IEnumerable<CurvePoint> ParseCurvePoints(XElement curveElement)
        {
            var items = curveElement.Descendants()
                .Where(e => e.Name.LocalName == "li" && e.Name.NamespaceName == XmpSchema.RdfNs);
            foreach (var li in items)
            {
                var text = li.Value;
                var comma = text.IndexOf(',');
                if (comma < 0) continue;
                if (TryParseDouble(text[..comma].Trim(), out var x) &&
                    TryParseDouble(text[(comma + 1)..].Trim(), out var y))
                {
                    yield return new CurvePoint(x, y);
                }
            }
        }

        private static void CollectSiblingPassthrough(XElement rdf, XElement primary, XmpSidecarDocument doc)
        {
            foreach (var sibling in rdf.Elements().Where(e => !ReferenceEquals(e, primary)))
            {
                doc.PassthroughRdfNodes.Add(sibling.ToString(SaveOptions.DisableFormatting));
            }
            var xmpmeta = rdf.Parent;
            if (xmpmeta is null) return;
            foreach (var sibling in xmpmeta.Elements().Where(e => !ReferenceEquals(e, rdf)))
            {
                doc.PassthroughXmpmetaNodes.Add(sibling.ToString(SaveOptions.DisableFormatting));
            }
        }

        // ── Name resolution and scoring ─────────────────────────────────────

        /// <summary>Canonical `prefix:Local` for a recognized attribute, independent of source prefix.</summary>
        private static string? CanonicalName(XAttribute attr)
        {
            var ns = attr.Name.NamespaceName;
            if (ns.Length == 0) return attr.Name.LocalName;
            var prefix = XmpSchema.CanonicalPrefixFor(ns);
            return prefix is null ? null : $"{prefix}:{attr.Name.LocalName}";
        }

        private static int ManagedNodeCount(XElement desc)
        {
            var attrs = desc.Attributes()
                .Count(a => !a.IsNamespaceDeclaration && CanonicalName(a) is { } n &&
                            n != "rdf:about" && ConsumedAttributes.Contains(n));
            var children = desc.Elements().Count(c => ToneCurveTag(c) is not null);
            return attrs + children;
        }

        private static string? ToneCurveTag(XElement child) =>
            XmpSchema.IsPappUri(child.Name.NamespaceName) &&
            XmpSchema.ToneCurveElements.Any(e => e.Tag == $"papp:{child.Name.LocalName}")
                ? child.Name.LocalName
                : null;

        private static bool DocumentCarriesPappNamespace(XDocument source) =>
            source.Descendants().Any(e =>
                XmpSchema.IsPappUri(e.Name.NamespaceName) ||
                e.Attributes().Any(a =>
                    XmpSchema.IsPappUri(a.Name.NamespaceName) ||
                    (a.IsNamespaceDeclaration && XmpSchema.IsPappUri(a.Value))));

        // ── Value parsers ───────────────────────────────────────────────────

        private static bool TryParseDouble(string text, out double value) =>
            double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) &&
            double.IsFinite(value);

        private static void Apply<T>(T? parsed, Action<T> assign) where T : struct
        {
            if (parsed.HasValue) assign(parsed.Value);
        }

        private static HighlightRecoveryMode? ParseHighlightRecovery(string v) => v.ToLowerInvariant() switch
        {
            "off" => HighlightRecoveryMode.Off,
            "blend" => HighlightRecoveryMode.Blend,
            "luminance" => HighlightRecoveryMode.Luminance,
            "chromaticadaptation" => HighlightRecoveryMode.ChromaticAdaptation,
            "oklabchromareduction" => HighlightRecoveryMode.OklabChromaReduction,
            _ => null,
        };

        private static ToggleMode? ParseToggle(string v) => v.ToLowerInvariant() switch
        {
            "on" => ToggleMode.On,
            "off" => ToggleMode.Off,
            _ => null,
        };

        /// <summary>ACR writes "1"/"0" for `crs:LensProfileEnable`; True/False/On/Off accepted too.</summary>
        private static ToggleMode? ParseOnOffBool(string v) => v.ToLowerInvariant() switch
        {
            "1" or "true" or "on" => ToggleMode.On,
            "0" or "false" or "off" => ToggleMode.Off,
            _ => null,
        };

        /// <summary>`crs:ConvertToGrayscale` accepts true/false in any case plus 1/0.</summary>
        private static ToggleMode? ParseTrueFalse(string v) => v.ToLowerInvariant() switch
        {
            "true" or "1" => ToggleMode.On,
            "false" or "0" => ToggleMode.Off,
            _ => null,
        };

        private static WbMethod? ParseWbMethod(string v) => v.ToLowerInvariant() switch
        {
            "cat16" => WbMethod.Cat16,
            "diagonalrec2020" => WbMethod.DiagonalRec2020,
            _ => null,
        };

        private static ToneCurveMode? ParseToneCurveMode(string v) => v.ToLowerInvariant() switch
        {
            "perchannel" => ToneCurveMode.PerChannel,
            "ratiopreserving" => ToneCurveMode.RatioPreserving,
            _ => null,
        };

        /// <summary>`papp:Look` parse + the legacy Look → Profile migration (#536).</summary>
        private static void ParseLook(string value, AdjustmentState state, ref bool profileSeen)
        {
            var v = value.ToLowerInvariant();
            if (v == "neutral") state.Look = LookMode.Neutral;
            else if (v == "default") state.Look = LookMode.Default;
            if (profileSeen) return;
            if (v is "default" or "auto") state.Profile = ProfileMode.Auto;
            else if (v == "neutral") state.Profile = ProfileMode.Neutral;
        }

        /// <summary>Rating clamped to 1..5; 0/absent/invalid = unrated (null).</summary>
        private static int? ParseRating(string value)
        {
            if (!TryParseDouble(value, out var n) || n < 0 || n > 5) return null;
            var rounded = (int)Math.Floor(n + 0.5);
            return rounded > 0 ? rounded : null;
        }

        private static string? ValidFlag(string? value) =>
            value is "pick" or "reject" ? value : null;

        private static string? ValidColorLabel(string? value) =>
            value is not null && XmpSchema.ColorLabels.Contains(value) ? value : null;

        /// <summary>Adobe `xmp:Label` color word → Maple color label (Lightroom interop).</summary>
        private static string? ColorLabelFromXmpLabel(string? label) => label switch
        {
            "Red" => "red",
            "Orange" => "orange",
            "Yellow" => "yellow",
            "Green" => "green",
            "Blue" => "blue",
            "Purple" => "purple",
            _ => null,
        };
    }
}
