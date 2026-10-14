using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    /// <summary>Read-only render model for Maple's brush container. The source
    /// XML remains passthrough-owned so Windows saves preserve it verbatim.</summary>
    internal static class XmpBrushCorrections
    {
        private static readonly XNamespace Crs = XmpSchema.CrsNs;
        private static readonly XNamespace Papp = XmpSchema.PappNs;
        private static readonly XNamespace PappLegacy = XmpSchema.PappNsLegacy;
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;
        private const int MaxDabsTextLength = 256 * 1024;
        private const int MaxBrushDabCount = 4096;

        private static string? Attr(XElement e, XName name) =>
            (e.Attribute(name) ?? (name.Namespace == Papp ? e.Attribute(PappLegacy + name.LocalName) : null))?.Value;

        public static IReadOnlyList<LocalAdjustment> Parse(XElement container)
        {
            var result = new List<LocalAdjustment>();
            var corrections = XmpLayerOrder.ContainerItems(container).Elements(Rdf + "Description").ToList();
            if (corrections.Count == 0) return result;
            foreach (var description in corrections)
            {
                var isActive = XmpLocalAdjustments.XmpBool(Attr(description, Crs + "CorrectionActive")) ?? true;
                var masks = description.Elements(Crs + "CorrectionMasks").FirstOrDefault();
                var leaf = masks?.Elements(Rdf + "Seq").Elements(Rdf + "li")
                    .FirstOrDefault(e => Attr(e, Crs + "What") == "Mask/Paint");
                if (leaf == null || Attr(leaf, Papp + "BrushVersion") != LocalMaskWire.BRUSH_VERSION.ToString(CultureInfo.InvariantCulture))
                    return Array.Empty<LocalAdjustment>();
                var dabs = ParseDabs(Attr(leaf, Papp + "Dabs"));
                if (dabs == null) return Array.Empty<LocalAdjustment>();
                // The canonical Rust parser rejects the whole brush container
                // when any correction is inactive; keep the Windows live
                // model aligned with exports and the other hosts.
                if (!isActive) return Array.Empty<LocalAdjustment>();
                var amount = Number(description, Crs + "CorrectionAmount") ?? 1;
                var a = new PartialAdjustments();
                foreach (var item in SliderAttrs)
                {
                    var value = Number(description, item.Name);
                    if (value is null) continue;
                    a = item.Set(a, value.Value * amount * item.Scale);
                }
                var digest = Attr(leaf, Papp + "BrushDigest");
                if (digest == null || digest.Length != 16 || digest.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))))
                    digest = Digest(dabs);
                result.Add(new LocalAdjustment(new BrushMask(dabs, digest), a, XmpLocalAdjustments.ParseRange(description))
                {
                    XmpLayerOrder = XmpLayerOrder.Read(description),
                });
            }
            return result;
        }

        internal static void RemovePassthroughContainers(XmpSidecarDocument document)
        {
            var keptNodes = new List<string>(document.PassthroughNodes.Count);
            var remappedIndexes = new int[document.PassthroughNodes.Count];
            Array.Fill(remappedIndexes, -1);
            var removedBrush = false;
            for (var index = 0; index < document.PassthroughNodes.Count; index++)
            {
                var node = document.PassthroughNodes[index];
                if (IsBrushContainer(node))
                {
                    removedBrush = true;
                    continue;
                }
                remappedIndexes[index] = keptNodes.Count;
                keptNodes.Add(node);
            }
            if (!removedBrush) return;

            document.PassthroughNodes = keptNodes;
            var childOrder = new List<ChildSlot>(document.ChildOrder.Count);
            foreach (var slot in document.ChildOrder)
            {
                if (slot.ModeledTag is not null || slot.PassthroughIndex < 0 ||
                    slot.PassthroughIndex >= remappedIndexes.Length)
                {
                    childOrder.Add(slot);
                    continue;
                }
                var newIndex = remappedIndexes[slot.PassthroughIndex];
                if (newIndex >= 0) childOrder.Add(ChildSlot.ForPassthrough(newIndex));
            }
            document.ChildOrder = childOrder;
            RebuildVerbatimLayerOrders(document);
        }

        internal static IReadOnlyList<string> PassthroughContainers(XmpSidecarDocument? document) =>
            document?.PassthroughNodes.Where(IsBrushContainer).ToArray() ?? Array.Empty<string>();

        internal static void RestorePassthroughContainers(XmpSidecarDocument document,
            IReadOnlyList<string> containers)
        {
            if (containers.Count == 0 || document.PassthroughNodes.Any(IsBrushContainer)) return;
            foreach (var container in containers)
            {
                if (!IsBrushContainer(container)) continue;
                document.PassthroughNodes.Add(container);
                document.ChildOrder.Add(ChildSlot.ForPassthrough(document.PassthroughNodes.Count - 1));
            }
            RebuildVerbatimLayerOrders(document);
        }

        private static void RebuildVerbatimLayerOrders(XmpSidecarDocument document)
        {
            var orders = document.PassthroughNodes
                .Where(IsBrushContainer)
                .SelectMany(xml => XmpLayerOrder.Keys(XmpLayerOrder.ContainerItems(XElement.Parse(xml))))
                .ToArray();
            document.VerbatimLayerOrders.Clear();
            document.VerbatimLayerOrders.AddRange(orders);
        }

        private static bool IsBrushContainer(string xml)
        {
            try { return XmpLayerOrder.IsBrushContainer(XElement.Parse(xml)); }
            catch (XmlException) { return false; }
        }

        public static string RenderFingerprint(AdjustmentState model)
        {
            var fingerprint = new StringBuilder();
            for (var index = 0; index < model.LocalAdjustments.Count; index++)
            {
                var layer = model.LocalAdjustments[index];
                if (layer.Mask is not BrushMask brush) continue;
                fingerprint.Append(index).Append(':').Append(brush.Digest).Append(':');
                foreach (var dab in brush.Dabs)
                {
                    Append(fingerprint, dab.Center.X); Append(fingerprint, dab.Center.Y);
                    Append(fingerprint, dab.Radius); Append(fingerprint, dab.Feather);
                    Append(fingerprint, dab.Weight); fingerprint.Append(dab.Erase ? '1' : '0').Append(';');
                }
                var a = layer.Adjustments;
                foreach (var value in new double?[]
                {
                    a.Exposure, a.Contrast, a.Highlights, a.Shadows, a.Whites, a.Blacks,
                    a.Saturation, a.Vibrance, a.Temperature, a.Tint, a.Hue,
                    a.Texture, a.Clarity, a.Dehaze, a.Sharpness, a.LuminanceNoise, a.Defringe,
                })
                    Append(fingerprint, value);
                if (layer.Range is { } range)
                {
                    Append(fingerprint, range.HueDeg); Append(fingerprint, range.HueHalfWidthDeg);
                    Append(fingerprint, range.ChromaMin); Append(fingerprint, range.LMin);
                    Append(fingerprint, range.LMax); Append(fingerprint, range.Feather);
                }
                else fingerprint.Append("no-range;");
                fingerprint.Append('|');
            }
            return fingerprint.ToString();
        }

        private static void Append(StringBuilder target, double value) =>
            target.Append(value.ToString("R", CultureInfo.InvariantCulture)).Append(';');

        private static void Append(StringBuilder target, double? value) =>
            target.Append(value?.ToString("R", CultureInfo.InvariantCulture) ?? "unset").Append(';');

        private static readonly (XName Name, double Scale, Func<PartialAdjustments,double,PartialAdjustments> Set)[] SliderAttrs =
        {
            (Crs+"LocalExposure2012",1,(a,v)=>a with {Exposure=v}), (Crs+"LocalContrast2012",1,(a,v)=>a with {Contrast=v}),
            (Crs+"LocalHighlights2012",1,(a,v)=>a with {Highlights=v}), (Crs+"LocalShadows2012",1,(a,v)=>a with {Shadows=v}),
            (Crs+"LocalWhites2012",1,(a,v)=>a with {Whites=v}), (Crs+"LocalBlacks2012",1,(a,v)=>a with {Blacks=v}),
            (Crs+"LocalSaturation",1,(a,v)=>a with {Saturation=v}), (Papp+"LocalVibrance",1,(a,v)=>a with {Vibrance=v}),
            (Crs+"LocalTemperature",1,(a,v)=>a with {Temperature=v}), (Crs+"LocalTint",1,(a,v)=>a with {Tint=v}),
            (Crs+"LocalHue",100,(a,v)=>a with {Hue=v}), (Crs+"LocalTexture",100,(a,v)=>a with {Texture=v}),
            (Crs+"LocalClarity2012",100,(a,v)=>a with {Clarity=v}), (Crs+"LocalDehaze",100,(a,v)=>a with {Dehaze=v}),
            (Crs+"LocalSharpness",100,(a,v)=>a with {Sharpness=v}), (Crs+"LocalLuminanceNoise",100,(a,v)=>a with {LuminanceNoise=v}),
            (Crs+"LocalDefringe",100,(a,v)=>a with {Defringe=v}),
        };

        private static double? Number(XElement e, XName name)
        {
            var raw = Attr(e, name);
            return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) && double.IsFinite(n) ? n : null;
        }

        private static IReadOnlyList<BrushDab>? ParseDabs(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return Array.Empty<BrushDab>();
            if (raw.Length > MaxDabsTextLength || HasTooManyTokens(raw, MaxBrushDabCount * 6)) return null;
            var tokens = raw.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length % 6 != 0 || tokens.Length / 6 > MaxBrushDabCount) return null;
            var dabs = new List<BrushDab>(tokens.Length / 6);
            for (var i = 0; i < tokens.Length; i += 6)
            {
                var v = new double[5];
                for (var j = 0; j < 5; j++)
                    if (!double.TryParse(tokens[i+j], NumberStyles.Float, CultureInfo.InvariantCulture, out v[j]) ||
                        !double.IsFinite(v[j]) || !float.IsFinite((float)v[j])) return null;
                if (tokens[i+5] is not ("0" or "1")) return null;
                dabs.Add(new BrushDab(new MaskPoint(v[0],v[1]),v[2],v[3],v[4],tokens[i+5]=="1"));
            }
            return dabs;
        }

        private static bool HasTooManyTokens(string value, int maximum)
        {
            var count = 0;
            var inToken = false;
            foreach (var character in value)
            {
                if (char.IsWhiteSpace(character))
                {
                    inToken = false;
                    continue;
                }
                if (inToken) continue;
                if (++count > maximum) return true;
                inToken = true;
            }
            return false;
        }

        private static string Digest(IReadOnlyList<BrushDab> dabs)
        {
            // FNV-1a over the canonical float wire, matching the other hosts' content key shape.
            ulong h = 0xcbf29ce484222325;
            void Mix(byte b) { h ^= b; h *= 0x100000001b3; }
            foreach (var d in dabs)
            {
                foreach (var n in new[] {d.Center.X,d.Center.Y,d.Radius,d.Feather,d.Weight})
                {
                    foreach (var b in BitConverter.GetBytes((float)n)) Mix(b);
                    for (var padding = 0; padding < 4; padding++) Mix(0);
                }
                Mix(d.Erase ? (byte)1 : (byte)0);
            }
            return h.ToString("x16", CultureInfo.InvariantCulture);
        }
    }
}
