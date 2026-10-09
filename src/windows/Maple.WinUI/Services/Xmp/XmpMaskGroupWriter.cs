using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    internal static partial class XmpLocalAdjustments
    {
        private static string Precise(double value) => value.ToString("R", CultureInfo.InvariantCulture);
        private static string Boolean(bool value) => value ? "True" : "False";

        private static XName OwnedName(string key) =>
            (key.StartsWith("crs:", StringComparison.Ordinal) ? Crs : Papp) + key[(key.IndexOf(':') + 1)..];

        private static void RemoveOwned(XElement element, string key)
        {
            element.Attribute(OwnedName(key))?.Remove();
            if (key.StartsWith("papp:", StringComparison.Ordinal))
                element.Attribute(PappLegacy + key[5..])?.Remove();
        }

        private static void SetOwned(XElement element, string key, string value)
        {
            RemoveOwned(element, key);
            element.SetAttributeValue(OwnedName(key), value);
        }

        private static void CanonicalBindings(XElement element)
        {
            var used = element.DescendantsAndSelf().SelectMany(e => e.Attributes())
                .Where(attribute => attribute.IsNamespaceDeclaration).Select(attribute => attribute.Name.LocalName).ToHashSet();
            foreach (var binding in new[] { ("rdf", Rdf.NamespaceName), ("crs", Crs.NamespaceName), ("papp", Papp.NamespaceName) })
            {
                var declaration = element.Attribute(XNamespace.Xmlns + binding.Item1);
                if (declaration is not null && declaration.Value != binding.Item2)
                {
                    var index = 0;
                    while (used.Contains("maskmeta" + index)) index++;
                    var alias = "maskmeta" + index;
                    used.Add(alias);
                    element.Add(new XAttribute(XNamespace.Xmlns + alias, declaration.Value));
                }
                // Adding last makes the canonical prefix the preferred binding
                // for owned fields, while foreign attributes retain their URI.
                declaration?.Remove();
                element.Add(new XAttribute(XNamespace.Xmlns + binding.Item1, binding.Item2));
            }
        }

        private static XElement GroupLeaf(MaskComponent component)
        {
            var leaf = component.XmpSource is null ? new XElement(Rdf + "li")
                : XElement.Parse(component.XmpSource, LoadOptions.PreserveWhitespace);
            CanonicalBindings(leaf);
            var subtract = component.Combine != MaskCombine.Add;
            SetOwned(leaf, "crs:MaskValue", subtract ? "0" : "1");
            SetOwned(leaf, "crs:MaskActive", "True");
            SetOwned(leaf, "crs:MaskBlendMode", subtract ? "1" : "0");
            SetOwned(leaf, "crs:MaskInverted", Boolean(component.Invert != (component.Combine == MaskCombine.Intersect)));
            SetOwned(leaf, "papp:MaskCombine", component.Combine.ToString());
            switch (component.Mask)
            {
                case LinearMask linear:
                    SetOwned(leaf, "crs:What", MaskWhatLinear);
                    SetOwned(leaf, "crs:ZeroX", Precise(linear.Start.X));
                    SetOwned(leaf, "crs:ZeroY", Precise(linear.Start.Y));
                    SetOwned(leaf, "crs:FullX", Precise(linear.End.X));
                    SetOwned(leaf, "crs:FullY", Precise(linear.End.Y));
                    SetOwned(leaf, "papp:LocalFeather", Precise(linear.Feather));
                    break;
                case RadialMask radial:
                    SetOwned(leaf, "crs:What", MaskWhatRadial);
                    SetOwned(leaf, "crs:Top", Precise(radial.Center.Y - radial.Radii.Y));
                    SetOwned(leaf, "crs:Left", Precise(radial.Center.X - radial.Radii.X));
                    SetOwned(leaf, "crs:Bottom", Precise(radial.Center.Y + radial.Radii.Y));
                    SetOwned(leaf, "crs:Right", Precise(radial.Center.X + radial.Radii.X));
                    SetOwned(leaf, "crs:Angle", Precise(RadiansToDegrees(radial.Angle)));
                    SetOwned(leaf, "crs:Feather", Precise(radial.Feather * 50));
                    SetOwned(leaf, "crs:Flipped", Boolean(!radial.Invert));
                    SetOwned(leaf, "crs:Midpoint", "50");
                    SetOwned(leaf, "crs:Roundness", "0");
                    SetOwned(leaf, "crs:Version", "2");
                    break;
                default:
                    throw new InvalidOperationException("A group component must be a supported leaf");
            }
            return leaf;
        }

        internal static string GroupCorrection(LocalAdjustment layer, double? order)
        {
            if (layer.Mask is not MaskGroup group) throw new ArgumentException("Expected a group", nameof(layer));
            var li = layer.XmpSource is null
                ? new XElement(Rdf + "li", new XAttribute(XNamespace.Xmlns + "rdf", Rdf.NamespaceName),
                    new XAttribute(XNamespace.Xmlns + "crs", Crs.NamespaceName),
                    new XAttribute(XNamespace.Xmlns + "papp", Papp.NamespaceName), new XElement(Rdf + "Description"))
                : XElement.Parse(layer.XmpSource, LoadOptions.PreserveWhitespace);
            CanonicalBindings(li);
            var description = li.Element(Rdf + "Description")!;
            SetOwned(description, "crs:What", "Correction");
            SetOwned(description, "crs:CorrectionAmount", "1");
            SetOwned(description, "crs:CorrectionActive", "True");
            if (order is { } layerOrder) SetOwned(description, LocalMaskWire.LAYER_ORDER_ATTRIBUTE, XmpLayerOrder.Format(layerOrder));
            else RemoveOwned(description, LocalMaskWire.LAYER_ORDER_ATTRIBUTE);
            SetOwned(description, "papp:MaskGroupVersion", LocalMaskWire.MASK_GROUP_VERSION.ToString(CultureInfo.InvariantCulture));
            SetOwned(description, "papp:MaskGroupOpacity", Precise(group.Opacity));
            SetOwned(description, "papp:MaskGroupInverted", Boolean(group.Invert));
            foreach (var slider in Sliders)
            {
                RemoveOwned(description, slider.Key);
                if (slider.Get(layer.Adjustments) is { } value && double.IsFinite(value))
                    SetOwned(description, slider.Key, FormatSlider(slider.Key, value));
            }
            foreach (var key in new[] { "RangeKind", "RangeHue", "RangeHueWidth", "RangeChromaMin",
                "RangeLMin", "RangeLMax", "RangeFeather" }) RemoveOwned(description, "papp:" + key);
            if (layer.Range is { } range)
            {
                SetOwned(description, "papp:RangeKind", "Color");
                foreach (var pair in new[] { ("RangeHue", range.HueDeg), ("RangeHueWidth", range.HueHalfWidthDeg),
                    ("RangeChromaMin", range.ChromaMin), ("RangeLMin", range.LMin),
                    ("RangeLMax", range.LMax), ("RangeFeather", range.Feather) })
                    SetOwned(description, "papp:" + pair.Item1, Precise(pair.Item2));
            }
            var masks = description.Element(Crs + MasksLocalName);
            if (masks is null)
            {
                masks = new XElement(Crs + MasksLocalName, new XElement(Rdf + "Seq"));
                description.Add(masks);
            }
            var seq = masks.Element(Rdf + "Seq")!;
            seq.Elements(Rdf + "li").Remove();
            seq.Add(group.Components.Select(GroupLeaf));
            return li.ToString(SaveOptions.DisableFormatting);
        }

        private static string? GroupBlock(IReadOnlyList<(LocalAdjustment Layer, double? Order)> keyed, string indent)
        {
            var groups = keyed.Where(entry => entry.Layer.Mask is MaskGroup).ToArray();
            return groups.Length == 0 ? null : string.Join("\n",
                new[] { $"{indent}<{GroupContainer}>", $"{indent}  <rdf:Seq>" }
                    .Concat(groups.Select(entry => indent + "    " + GroupCorrection(entry.Layer, entry.Order)))
                    .Concat(new[] { $"{indent}  </rdf:Seq>", $"{indent}</{GroupContainer}>" }));
        }
    }
}
