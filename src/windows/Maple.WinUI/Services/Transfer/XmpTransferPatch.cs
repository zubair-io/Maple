using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Transfer;

public sealed record XmpTransferPatch(Dictionary<string, string?> Attributes, Dictionary<string, string?> Elements)
{
    private static XName Name(string key)
    {
        var parts = key.Split(':', 2);
        var known = XmpSchema.KnownNamespaces.FirstOrDefault(n => n.Prefix == parts[0]);
        if (parts.Length != 2 || known.Uris == null) throw new InvalidDataException("Unknown XMP transfer name: " + key);
        return XName.Get(parts[1], known.Uris[0]);
    }

    public static XmpTransferPatch Build(AdjustmentTransferPatch patch)
    {
        var document = new XmpSidecarDocument();
        AdjustmentTransfer.Apply(document, patch);
        var xml = XDocument.Parse(XmpWriter.Serialize(document));
        var description = xml.Descendants(Name("rdf:Description")).FirstOrDefault()
            ?? throw new InvalidDataException("The copied settings have no RDF description.");
        var attributes = new Dictionary<string, string?>(StringComparer.Ordinal);
        var elements = new Dictionary<string, string?>(StringComparer.Ordinal);
        void Attribute(string key) => attributes[key] = description.Attribute(Name(key))?.Value;
        foreach (var field in patch.Fields.Keys)
        {
            if (AdjustmentFields.TransferAttributes.TryGetValue(field, out var keys))
                foreach (var key in keys) Attribute(key);
            if (!AdjustmentFields.TransferElements.TryGetValue(field, out var element)) continue;
            var node = description.Element(Name(element));
            if (node == null) { elements[element] = null; continue; }
            var clone = new XElement(node);
            foreach (var prefix in new[] { "crs", "papp", "rdf" })
                clone.SetAttributeValue(XNamespace.Xmlns + prefix, Name(prefix + ":value").NamespaceName);
            elements[element] = clone.ToString(SaveOptions.DisableFormatting);
        }
        if (patch.WhiteBalanceScaleVersion.HasValue)
        {
            Attribute("crs:WhiteBalance");
            Attribute("papp:WbScaleVersion");
            attributes["papp:WbSampleX"] = attributes["papp:WbSampleY"] = attributes["papp:WbAlgorithmVersion"] = null;
        }
        return new(attributes, elements);
    }
}
