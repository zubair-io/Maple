using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp;

/// <summary>Lossless structured repair editing over the shared Adobe wire form.</summary>
public static class XmpRetouch
{
    public const string Tag = "crs:RetouchAreas";
    private static readonly XNamespace Crs = XmpSchema.CrsNs;
    private static readonly XNamespace Rdf = XmpSchema.RdfNs;

    public static bool IsContainer(XElement element) => element.Name == Crs + "RetouchAreas";

    // Struct form wins. The parser keeps the legacy source as passthrough too,
    // so entries this host cannot interpret remain available to newer readers.
    public static RetouchState ReadLegacy(XElement container)
    {
        var state = RetouchState.Empty;
        foreach (var item in container.Element(Rdf + "Seq")?.Elements(Rdf + "li") ?? Enumerable.Empty<XElement>())
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var field in item.Value.Split(','))
            {
                var split = field.IndexOf('=');
                if (split > 0) values[field[..split].Trim()] = field[(split + 1)..].Trim();
            }
            double? Get(string key) => values.TryGetValue(key, out var text)
                && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                && double.IsFinite(value) ? value : null;
            if (!values.TryGetValue("spotType", out var type) || Kind(type) is not { } kind
                || Get("centerX") is not { } x || Get("centerY") is not { } y || Get("radius") is not { } radius
                || Get("sourceX") is not { } sx || Get("sourceY") is not { } sy) continue;
            var spot = new RetouchSpot(kind, x, y, sx, sy, radius, Get("feather") ?? .5, Get("opacity") ?? 1);
            // Imported data may be outside the author's UI range; preserve its
            // exact meaning for the core instead of clamping it during import.
            var root = Root(state);
            Append(root, spot);
            state = Read(root);
        }
        return state;
    }

    public static RetouchState Read(XElement container)
    {
        var spots = new List<RetouchEntry>();
        var items = Items(container);
        for (var i = 0; i < items.Length; i++)
        {
            var desc = Description(items[i]);
            var mask = Mask(desc);
            if (mask == null || Kind(desc.Attribute(Crs + "SpotType")?.Value) is not { } kind) continue;
            var x = Number(mask, "X");
            var y = Number(mask, "Y");
            var radius = Number(mask, "Radius");
            var sx = Number(desc, "SourceX") ?? Add(x, Number(desc, "OffsetX"));
            var sy = Number(desc, "SourceY") ?? Add(y, Number(desc, "OffsetY"));
            var feather = Number(mask, "Feather") ?? Number(desc, "Feather") ?? 0.5;
            var opacity = Number(desc, "Opacity") ?? 1;
            if (x is null || y is null || radius is null || sx is null || sy is null) continue;
            spots.Add(new(i, new(kind, x.Value, y.Value, sx.Value, sy.Value, radius.Value, feather, opacity)));
        }
        return new(container.ToString(SaveOptions.DisableFormatting), spots);
    }

    public static RetouchState Add(RetouchState state, RetouchSpot spot)
    {
        Validate(spot);
        var root = Root(state);
        Append(root, spot);
        return Read(root);
    }

    private static void Append(XElement root, RetouchSpot spot)
    {
        var seq = root.Element(Rdf + "Seq");
        if (seq == null) { seq = new XElement(Rdf + "Seq"); root.Add(seq); }
        var desc = new XElement(Rdf + "Description",
            new XAttribute(Crs + "SourceState", "sourceSetExplicitly"),
            new XAttribute(Crs + "Method", "circle"), new XAttribute(Crs + "Seed", "0"),
            new XElement(Crs + "Masks", new XElement(Rdf + "Seq",
                new XElement(Rdf + "li", new XAttribute(Crs + "What", "Mask/CircularGradient"),
                    new XAttribute(Crs + "MaskValue", "1"), new XAttribute(Crs + "Flow", "1"),
                    new XAttribute(Crs + "CenterWeight", "0")))));
        Set(desc, spot);
        seq.Add(new XElement(Rdf + "li", desc));
    }

    public static RetouchState Replace(RetouchState state, int index, RetouchSpot spot)
    {
        Validate(spot);
        var entry = Entry(state, index);
        if (entry.Spot == spot) return state;
        var root = Root(state);
        Set(Description(Items(root)[entry.XmlIndex]), spot);
        return Read(root);
    }

    public static RetouchState Remove(RetouchState state, int index)
    {
        var entry = Entry(state, index);
        var root = Root(state);
        Items(root)[entry.XmlIndex].Remove();
        return Read(root);
    }

    private static RetouchEntry Entry(RetouchState state, int index) =>
        index >= 0 && index < state.Spots.Count ? state.Spots[index] : throw new ArgumentOutOfRangeException(nameof(index));

    private static XElement Root(RetouchState state) => state.Xml is { } xml
        ? XElement.Parse(xml, LoadOptions.PreserveWhitespace)
        : new XElement(Crs + "RetouchAreas", new XAttribute(XNamespace.Xmlns + "crs", Crs.NamespaceName),
            new XAttribute(XNamespace.Xmlns + "rdf", Rdf.NamespaceName), new XElement(Rdf + "Seq"));

    private static XElement[] Items(XElement root) => root.Element(Rdf + "Seq")?.Elements(Rdf + "li").ToArray() ?? Array.Empty<XElement>();
    private static XElement Description(XElement item) => item.Element(Rdf + "Description") ?? item;
    private static XElement? Mask(XElement desc) => desc.Element(Crs + "Masks")?.Element(Rdf + "Seq")?
        .Elements(Rdf + "li").FirstOrDefault(e => e.Attribute(Crs + "What")?.Value == "Mask/CircularGradient");
    private static RetouchKind? Kind(string? text) => text switch { "heal" => RetouchKind.Heal, "clone" => RetouchKind.Clone, _ => null };
    private static double? Number(XElement el, string name) => double.TryParse(el.Attribute(Crs + name)?.Value,
        NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : null;
    private static double? Add(double? a, double? b) => a.HasValue && b.HasValue ? a + b : null;
    private static string Format(double value) => Math.Round(value, 6, MidpointRounding.AwayFromZero).ToString("F6", CultureInfo.InvariantCulture);

    private static void Set(XElement desc, RetouchSpot spot)
    {
        desc.SetAttributeValue(Crs + "SpotType", spot.Kind == RetouchKind.Heal ? "heal" : "clone");
        desc.SetAttributeValue(Crs + "SourceX", Format(spot.SourceX));
        desc.SetAttributeValue(Crs + "SourceY", Format(spot.SourceY));
        desc.SetAttributeValue(Crs + "Feather", Format(spot.Feather));
        desc.SetAttributeValue(Crs + "Opacity", Format(spot.Opacity));
        var mask = Mask(desc) ?? throw new InvalidOperationException("Repair has no circular mask");
        mask.SetAttributeValue(Crs + "X", Format(spot.X));
        mask.SetAttributeValue(Crs + "Y", Format(spot.Y));
        mask.SetAttributeValue(Crs + "Radius", Format(spot.Radius));
        // A mask-local feather takes precedence over the description value.
        if (mask.Attribute(Crs + "Feather") != null) mask.SetAttributeValue(Crs + "Feather", Format(spot.Feather));
    }

    private static void Validate(RetouchSpot spot)
    {
        if (!Enum.IsDefined(spot.Kind) || new[] { spot.X, spot.Y, spot.SourceX, spot.SourceY, spot.Radius, spot.Feather, spot.Opacity }
            .Any(v => !double.IsFinite(v) || v < 0 || v > 1) || spot.Radius == 0)
            throw new ArgumentOutOfRangeException(nameof(spot), "Repair coordinates, size, feather and opacity must be finite image fractions.");
    }
}
