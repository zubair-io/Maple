using System;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    internal static partial class XmpLocalAdjustments
    {
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;

        private static bool ValidOptionalNumbers(XElement element, params string[] keys) =>
            keys.All(key => Attr(element, key) is null || Finite(element, key) is not null);

        private static bool ValidOptionalBooleans(XElement element, params string[] keys) =>
            keys.All(key => Attr(element, key) is null || XmpBool(Attr(element, key)) is not null);

        private static MaskComponent? ParseGroupComponent(XElement leaf)
        {
            if (!ValidOptionalNumbers(leaf, "crs:MaskBlendMode", "crs:MaskValue", "crs:Version",
                    "crs:Angle", "crs:Feather", "papp:LocalFeather", "crs:Midpoint", "crs:Roundness")
                || !ValidOptionalBooleans(leaf, "crs:MaskActive", "crs:MaskInverted", "crs:Flipped")
                || XmpBool(Attr(leaf, "crs:MaskActive")) == false) return null;
            var version = Finite(leaf, "crs:Version") ?? 1;
            if (version != 1 && version != 2) return null;
            LocalMask? mask = Attr(leaf, "crs:What") switch
            {
                MaskWhatLinear => ParseLinearLeaf(leaf),
                MaskWhatRadial => ParseGroupRadial(leaf),
                _ => null,
            };
            if (mask is null) return null;
            var mode = Finite(leaf, "crs:MaskBlendMode") ?? 0;
            var value = Finite(leaf, "crs:MaskValue") ?? 1;
            var inverted = XmpBool(Attr(leaf, "crs:MaskInverted")) ?? false;
            MaskCombine? adobe = (mode, value) switch
            {
                (0, 1) => MaskCombine.Add,
                (1, 0) => inverted ? MaskCombine.Intersect : MaskCombine.Subtract,
                _ => null,
            };
            if (adobe is null) return null;
            MaskCombine? combine = Attr(leaf, "papp:MaskCombine") switch
            {
                null => adobe,
                "Add" when mode == 0 => MaskCombine.Add,
                "Subtract" when mode == 1 => MaskCombine.Subtract,
                "Intersect" when mode == 1 => MaskCombine.Intersect,
                _ => null,
            };
            return combine is null ? null : new MaskComponent(mask, combine.Value,
                inverted != (combine == MaskCombine.Intersect)) { XmpSource = SelfContained(leaf) };
        }

        private static LocalMask? ParseGroupRadial(XElement leaf)
        {
            // Maple models an ellipse. Preserve other Adobe shapes opaquely.
            if ((Finite(leaf, "crs:Midpoint") ?? 50) != 50
                || (Finite(leaf, "crs:Roundness") ?? 0) != 0) return null;
            var radial = ParseRadialLeaf(leaf) as RadialMask;
            if (radial is null || radial.Radii.X <= 0 || radial.Radii.Y <= 0
                || !double.IsFinite(radial.Center.X) || !double.IsFinite(radial.Center.Y)
                || !double.IsFinite(radial.Radii.X) || !double.IsFinite(radial.Radii.Y)
                || !double.IsFinite(radial.Angle)) return null;
            return radial;
        }

        internal static LocalAdjustment? ParseGroupCorrection(XElement li)
        {
            var descriptions = li.Elements(Rdf + "Description").ToArray();
            if (descriptions.Length != 1) return null;
            var description = descriptions[0];
            var version = Attr(description, "papp:MaskGroupVersion");
            if ((version is not null && version != LocalMaskWire.MASK_GROUP_VERSION.ToString(CultureInfo.InvariantCulture))
                || !ValidOptionalNumbers(description, "papp:MaskGroupOpacity", "crs:CorrectionAmount")
                || !ValidOptionalBooleans(description, "papp:MaskGroupInverted", "crs:CorrectionActive")
                || XmpBool(Attr(description, "crs:CorrectionActive")) == false) return null;
            var masks = description.Elements(Crs + MasksLocalName).ToArray();
            var sequences = masks.Length == 1 ? masks[0].Elements(Rdf + "Seq").ToArray() : Array.Empty<XElement>();
            if (sequences.Length != 1 || sequences[0].Elements().Any(e => e.Name != Rdf + "li")) return null;
            var components = sequences[0].Elements(Rdf + "li").Select(ParseGroupComponent).ToArray();
            if (components.Length == 0 || components.Any(component => component is null)) return null;
            if (Sliders.Any(slider => !ValidOptionalNumbers(description, slider.Key))) return null;
            var range = ParseRange(description);
            if (Attr(description, "papp:RangeKind") is not null && range is null) return null;
            var amount = Finite(description, "crs:CorrectionAmount") ?? 1;
            var adjustments = Sliders.Aggregate(new PartialAdjustments(), (acc, slider) =>
            {
                var value = Finite(description, slider.Key);
                return value is null ? acc : slider.With(acc, value.Value * amount);
            });
            var group = new MaskGroup(components.Select(component => component!).ToArray(),
                Finite(description, "papp:MaskGroupOpacity") ?? 1,
                XmpBool(Attr(description, "papp:MaskGroupInverted")) ?? false);
            return new LocalAdjustment(group, adjustments, range) { XmpSource = SelfContained(li) };
        }

        // Copy in-scope namespace bindings before detaching, including aliases
        // and foreign bindings that happen to use Maple's reserved prefixes.
        internal static string SelfContained(XElement element)
        {
            var copy = new XElement(element);
            foreach (var attr in element.AncestorsAndSelf().SelectMany(e => e.Attributes())
                .Where(a => a.IsNamespaceDeclaration).DistinctBy(a => a.Name))
                if (copy.Attribute(attr.Name) is null && !XmpGroupSource.CanonicalBinding(attr)) copy.Add(new XAttribute(attr));
            foreach (var binding in new[] { ("rdf", XmpSchema.RdfNs), ("crs", XmpSchema.CrsNs), ("papp", XmpSchema.PappNs) })
                if (copy.Attribute(XNamespace.Xmlns + binding.Item1) is null)
                    copy.Add(new XAttribute(XNamespace.Xmlns + binding.Item1, binding.Item2));
            return copy.ToString(SaveOptions.DisableFormatting);
        }
    }
}
