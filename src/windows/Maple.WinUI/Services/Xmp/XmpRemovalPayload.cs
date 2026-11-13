// #1472: transport the one owned RDF payload into every Windows snapshot.
// Schema/JSON/asset validation belongs to Rust, including future-version refusal.
using System.Linq;
using System.Xml.Linq;

namespace Maple.WinUI.Services.Xmp;

internal static class XmpRemovalPayload
{
    internal static bool TryTake(XDocument source, out string? records)
    {
        records = null;
        var descriptions = source.Descendants(XNamespace.Get(XmpSchema.RdfNs) + "Description");
        var attributes = descriptions.Attributes().Where(attribute => Owned(attribute.Name)).ToArray();
        var properties = descriptions.Elements().Where(element => Owned(element.Name)).ToArray();
        if (attributes.Length + properties.Length > 1 || properties.Any(property => property.HasElements))
            return false;
        if (attributes.Length == 1)
        {
            records = attributes[0].Value;
            attributes[0].Remove();
        }
        if (properties.Length == 1)
        {
            records = properties[0].Value;
            properties[0].Remove();
        }
        return true;
    }

    private static bool Owned(XName name) => name.LocalName == "InpaintRemovals"
        && XmpSchema.IsPappUri(name.NamespaceName);
}
