// XmpWriter — canonical sidecar serializer for the Windows shell.
//
// Emits the byte-canonical document shape pinned by
// `docs/xmp-canonical-format.md` and implemented by the TypeScript
// `XmpSerializerService` / `xmp-canonical.ts`: fixed envelope, LF line
// endings, two-space indentation ladder, the three core namespace
// declarations in fixed order, attributes sorted by namespace priority then
// name, non-default fields only, and passthrough re-emitted verbatim.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    public static class XmpWriter
    {
        /// <summary>Indent of `rdf:Description`'s namespace declarations, attributes and children.</summary>
        private const string ChildIndent = "      ";

        public static string Serialize(XmpSidecarDocument doc)
        {
            var parts = new List<string>
            {
                $"crs:Version=\"{XmpSchema.EscapeAttr(doc.Version)}\"",
                $"crs:ProcessVersion=\"{XmpSchema.EscapeAttr(doc.ProcessVersion)}\"",
                "crs:HasSettings=\"True\"",
            };

            var emittedKeys = AppendNumericFields(parts, doc.Adjustments);
            if (emittedKeys.Contains("crs:Temperature") || emittedKeys.Contains("crs:Tint"))
            {
                parts.Add($"papp:WbScaleVersion=\"{doc.WbScaleVersion.ToString(CultureInfo.InvariantCulture)}\"");
            }

            AppendEnumFields(parts, doc.Adjustments);
            AppendCropFields(parts, doc.Adjustments);
            AppendCullingFields(parts, doc);

            foreach (var attr in doc.PassthroughAttributes)
            {
                parts.Add($"{attr.Name}=\"{XmpSchema.EscapeAttr(attr.Value)}\"");
            }

            var children = BuildChildren(doc);
            return AssembleDocument(doc, parts, children);
        }

        // ── Attribute groups ────────────────────────────────────────────────

        /// <summary>
        /// Numeric sliders, emitted only when non-default. The comparison is
        /// between serialized wire forms, not raw doubles, so near-default
        /// values that round to the default wire string are omitted too
        /// (mirrors the web writer, PR #2192).
        /// </summary>
        private static HashSet<string> AppendNumericFields(List<string> parts, AdjustmentState state)
        {
            var emitted = new HashSet<string>();
            foreach (var field in XmpSchema.NumericFields)
            {
                var wire = XmpSchema.FormatNumber(field.Get(state));
                var defaultWire = XmpSchema.FormatNumber(field.Get(XmpSchema.Defaults));
                if (wire == defaultWire) continue;
                parts.Add($"{field.Key}=\"{wire}\"");
                emitted.Add(field.Key);
            }
            return emitted;
        }

        /// <summary>Enum fields — each emitted only when non-default, canonical wire spelling.</summary>
        private static void AppendEnumFields(List<string> parts, AdjustmentState state)
        {
            if (state.HighlightRecovery != HighlightRecoveryMode.ChromaticAdaptation)
            {
                parts.Add($"papp:HighlightRecoveryMode=\"{state.HighlightRecovery}\"");
            }
            if (state.AutoExposure != ToggleMode.On)
            {
                parts.Add("papp:AutoExposure=\"Off\"");
            }
            if (state.Look != LookMode.Default)
            {
                parts.Add($"papp:Look=\"{state.Look}\"");
            }
            if (state.Profile != ProfileMode.Auto)
            {
                parts.Add($"papp:Profile=\"{state.Profile}\"");
            }
            if (state.HotPixelSuppression != ToggleMode.Off)
            {
                parts.Add("papp:HotPixelSuppression=\"On\"");
            }
            if (state.LensProfileEnable == ToggleMode.Off)
            {
                // ACR's "0" spelling so Lightroom reads it back (#376).
                parts.Add("crs:LensProfileEnable=\"0\"");
            }
            if (state.WbMethod != WbMethod.Cat16)
            {
                parts.Add($"papp:WbMethod=\"{state.WbMethod}\"");
            }
            if (state.ToneCurveMode != ToneCurveMode.PerChannel)
            {
                parts.Add($"papp:ToneCurveMode=\"{state.ToneCurveMode}\"");
            }
            if (state.BlackWhite == ToggleMode.On)
            {
                parts.Add("crs:ConvertToGrayscale=\"True\"");
            }
        }

        /// <summary>Crop wire form (docs/xmp-canonical-format.md § Crop fields):
        /// crs:HasCrop gates the six-decimal rect; the angle is emitted alone
        /// for a pure straighten and parsed unconditionally on read.</summary>
        private static void AppendCropFields(List<string> parts, AdjustmentState state)
        {
            var crop = state.Crop;
            var emitRect = !crop.RectIsIdentity && crop.RectIsValid;
            if (emitRect)
            {
                parts.Add("crs:HasCrop=\"True\"");
                parts.Add($"crs:CropTop=\"{FmtCrop(crop.Top)}\"");
                parts.Add($"crs:CropLeft=\"{FmtCrop(crop.Left)}\"");
                parts.Add($"crs:CropBottom=\"{FmtCrop(crop.Bottom)}\"");
                parts.Add($"crs:CropRight=\"{FmtCrop(crop.Right)}\"");
                parts.Add("crs:CropConstrainToWarp=\"0\"");
            }
            if (crop.Angle != 0)
            {
                parts.Add($"crs:CropAngle=\"{FmtCrop(crop.Angle)}\"");
            }
        }

        private static string FmtCrop(double v) => v.ToString("0.000000", CultureInfo.InvariantCulture);

        private static void AppendCullingFields(List<string> parts, XmpSidecarDocument doc)
        {
            if (doc.Rating is > 0)
            {
                var rating = Math.Min(doc.Rating.Value, 5);
                parts.Add($"xmp:Rating=\"{rating.ToString(CultureInfo.InvariantCulture)}\"");
            }
            if (doc.Flag is "pick" or "reject")
            {
                parts.Add($"papp:Flag=\"{doc.Flag}\"");
            }
            if (!string.IsNullOrEmpty(doc.ColorLabel))
            {
                parts.Add($"papp:ColorLabel=\"{XmpSchema.EscapeAttr(doc.ColorLabel)}\"");
            }
        }

        // ── Nested children ─────────────────────────────────────────────────

        /// <summary>
        /// Interleaves the modeled tone-curve blocks back into passthrough
        /// content at their original source position (#2671), via
        /// <see cref="XmpSidecarDocument.ChildOrder"/>. A tone-curve tag
        /// that is now identity (no points) emits nothing at its slot —
        /// "identity is silence" — while every other recorded slot still
        /// runs in source order. A curve with no recorded slot (never
        /// parsed, or added since) falls back to the pre-#2671 default:
        /// before every recorded slot, in canonical order — the same
        /// output a document with no passthrough content produced before
        /// this fix. Two defensive rules keep a `ChildOrder` that is
        /// missing, stale, or out of sync with <see cref="XmpSidecarDocument.PassthroughNodes"/>
        /// (nothing stops a caller from mutating that list directly, and
        /// nothing required doing so before this PR) from losing content or
        /// crashing the save: every `PassthroughNodes` entry not visited by
        /// a recorded slot is appended afterward rather than dropped, and a
        /// recorded tag `XmpSchema.ToneCurveElements` doesn't recognize is
        /// looked up with `TryGetValue` rather than the indexer.
        /// </summary>
        private static string BuildChildren(XmpSidecarDocument doc)
        {
            var curveBlocks = XmpSchema.ToneCurveElements
                .ToDictionary(e => e.Tag, e => ToneCurveBlock(e.Tag, e.Curve(doc.Adjustments)));

            var recordedTags = new HashSet<string>();
            var visitedPassthroughIndexes = new HashSet<int>();
            var blocks = new List<string>();
            foreach (var slot in doc.ChildOrder)
            {
                if (slot.ToneCurveTag is { } tag)
                {
                    recordedTags.Add(tag);
                    if (curveBlocks.TryGetValue(tag, out var block) && block is not null) blocks.Add(block);
                }
                else if (slot.PassthroughIndex >= 0 && slot.PassthroughIndex < doc.PassthroughNodes.Count)
                {
                    // HashSet.Add returns false for an index already seen —
                    // a stale/out-of-sync ChildOrder that repeats the same
                    // PassthroughIndex must not duplicate that node in the
                    // output; only the first occurrence emits (Copilot
                    // review on #3113).
                    if (!visitedPassthroughIndexes.Add(slot.PassthroughIndex)) continue;
                    // Preserved unknown node: first line re-indented onto
                    // the canonical ladder, interior whitespace kept as
                    // authored.
                    blocks.Add($"{ChildIndent}{doc.PassthroughNodes[slot.PassthroughIndex]}");
                }
            }

            // Never silently drop a passthrough node just because
            // ChildOrder didn't record its position.
            for (var i = 0; i < doc.PassthroughNodes.Count; i++)
            {
                if (!visitedPassthroughIndexes.Contains(i))
                {
                    blocks.Add($"{ChildIndent}{doc.PassthroughNodes[i]}");
                }
            }

            var freshCurveBlocks = XmpSchema.ToneCurveElements
                .Where(e => !recordedTags.Contains(e.Tag))
                .Select(e => curveBlocks[e.Tag])
                .Where(b => b is not null)
                .Select(b => b!);
            blocks.InsertRange(0, freshCurveBlocks);

            return string.Join("\n", blocks);
        }

        /// <summary>
        /// One `papp:SceneLinearToneCurve*` block (#365), or null for an
        /// identity (empty) curve — "identity is silence". Coordinates are
        /// stored on the Windows model in the wire domain `[0, 255]`
        /// already, so they go straight through the number codec.
        /// </summary>
        private static string? ToneCurveBlock(string tag, List<CurvePoint> points)
        {
            if (points.Count == 0) return null;
            return string.Join("\n", new[]
                {
                    $"{ChildIndent}<{tag}>",
                    $"{ChildIndent}  <rdf:Seq>",
                }
                .Concat(points.Select(p =>
                    $"{ChildIndent}    <rdf:li>{XmpSchema.FormatNumber(p.X)}, {XmpSchema.FormatNumber(p.Y)}</rdf:li>"))
                .Concat(new[]
                {
                    $"{ChildIndent}  </rdf:Seq>",
                    $"{ChildIndent}</{tag}>",
                }));
        }

        // ── Document assembly ───────────────────────────────────────────────

        /// <summary>
        /// Canonical attribute order: namespace priority (xmp, crs, papp, dc,
        /// exif, photoshop, Iptc4xmpCore, xmpRights, then unknown) and
        /// alphabetical by fully-qualified name within each namespace.
        /// </summary>
        private static List<string> SortedAttributeParts(IEnumerable<string> parts) =>
            parts.OrderBy(p => XmpSchema.PrefixPriority(AttributeName(p)))
                 .ThenBy(AttributeName, StringComparer.Ordinal)
                 .ToList();

        private static string AttributeName(string part) => part[..part.IndexOf('=')];

        private static string AssembleDocument(
            XmpSidecarDocument doc, List<string> parts, string children)
        {
            var namespaces = new List<(string Prefix, string Uri)>
            {
                ("xmp", XmpSchema.XmpNs),
                ("crs", XmpSchema.CrsNs),
                ("papp", XmpSchema.PappNs),
            };
            var declared = new HashSet<string> { "x", "rdf", "xmp", "crs", "papp" };
            foreach (var ns in doc.PassthroughNamespaces
                         .OrderBy(n => n.Prefix, StringComparer.Ordinal))
            {
                if (declared.Add(ns.Prefix)) namespaces.Add((ns.Prefix, ns.Uri));
            }

            var head = namespaces
                .Select(ns => $"{ChildIndent}xmlns:{ns.Prefix}=\"{XmpSchema.EscapeAttr(ns.Uri)}\"")
                .Concat(SortedAttributeParts(parts).Select(p => $"{ChildIndent}{p}"));
            var body = children.Length == 0 ? "/>" : $">\n{children}\n    </rdf:Description>";

            var lines = new List<string>
            {
                // The `begin` value is a literal U+FEFF byte-order mark,
                // written as an explicit escape so an editor pass can never
                // silently strip it (mirrors xmp-canonical.ts).
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                $"{string.Join("\n", head)}{body}",
            };
            // Preserved rdf:RDF / x:xmpmeta siblings: first line re-indented
            // onto the canonical ladder, interior kept as authored.
            lines.AddRange(doc.PassthroughRdfNodes.Select(n => $"    {n}"));
            lines.Add("  </rdf:RDF>");
            lines.AddRange(doc.PassthroughXmpmetaNodes.Select(n => $"  {n}"));
            lines.Add("</x:xmpmeta>");
            lines.Add("<?xpacket end=\"w\"?>");
            return string.Join("\n", lines);
        }
    }
}
