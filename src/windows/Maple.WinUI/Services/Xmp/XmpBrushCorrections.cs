using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
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

        private static string? Attr(XElement e, XName name) =>
            (e.Attribute(name) ?? (name.Namespace == Papp ? e.Attribute(PappLegacy + name.LocalName) : null))?.Value;

        public static IReadOnlyList<LocalAdjustment> Parse(XElement container)
        {
            var result = new List<LocalAdjustment>();
            var corrections = container.Descendants(Rdf + "Description").ToList();
            if (corrections.Count == 0) return result;
            foreach (var description in corrections)
            {
                if (Attr(description, Crs + "What") != "Correction") return Array.Empty<LocalAdjustment>();
                var active = Attr(description, Crs + "CorrectionActive");
                var isActive = active == null || !active.Trim().Equals("false", StringComparison.OrdinalIgnoreCase);
                var masks = description.Elements(Crs + "CorrectionMasks").FirstOrDefault();
                var leaf = masks?.Descendants(Rdf + "li").FirstOrDefault(e => Attr(e, Crs + "What") == "Mask/Paint");
                if (leaf == null || Attr(leaf, Papp + "BrushVersion") != "1") return Array.Empty<LocalAdjustment>();
                var dabs = ParseDabs(Attr(leaf, Papp + "Dabs"));
                if (dabs == null) return Array.Empty<LocalAdjustment>();
                if (!isActive) continue;
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
            var tokens = raw.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length % 6 != 0) return null;
            var dabs = new List<BrushDab>(tokens.Length / 6);
            for (var i = 0; i < tokens.Length; i += 6)
            {
                var v = new double[5];
                for (var j = 0; j < 5; j++)
                    if (!double.TryParse(tokens[i+j], NumberStyles.Float, CultureInfo.InvariantCulture, out v[j]) || !double.IsFinite(v[j])) return null;
                if (tokens[i+5] is not ("0" or "1")) return null;
                dabs.Add(new BrushDab(new MaskPoint(v[0],v[1]),v[2],v[3],v[4],tokens[i+5]=="1"));
            }
            return dabs;
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
