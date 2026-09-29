using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace Maple.WinUI.Services.Metadata;

/// <summary>Read-only projection of standard XMP metadata. Does not instantiate
/// adjustments or a decoder and never rewrites sidecar passthrough XML.</summary>
public static class InspectorMetadata
{
    public static IReadOnlyList<(string Label, string Value)> ReadXmp(string? xml)
    {
        var rows = new List<(string, string)>();
        if (string.IsNullOrWhiteSpace(xml)) return rows;
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 4 * 1024 * 1024,
        });
        var document = XDocument.Load(reader);
        XNamespace dc = "http://purl.org/dc/elements/1.1/";
        XNamespace rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
        XNamespace exif = "http://ns.adobe.com/exif/1.0/";
        XNamespace photoshop = "http://ns.adobe.com/photoshop/1.0/";
        string Values(XName name)
        {
            var elements = document.Descendants(name).ToArray();
            var list = elements.SelectMany(e => e.Descendants(rdf + "li")).Select(e => e.Value).ToArray();
            return string.Join(", ", (list.Length > 0 ? list : elements.Select(e => e.Value))
                .Concat(document.Descendants().Attributes(name).Select(a => a.Value)).Where(v => !string.IsNullOrWhiteSpace(v)).Distinct());
        }
        void Add(string label, string value) { if (value.Length > 0) rows.Add((label, value)); }
        Add("Title", Values(dc + "title"));
        Add("Caption", Values(dc + "description"));
        Add("Creator", Values(dc + "creator"));
        Add("Copyright", Values(dc + "rights"));
        Add("Keywords", Values(dc + "subject"));
        Add("Location", string.Join(", ", new[] { Values(photoshop + "City"), Values(photoshop + "State"), Values(photoshop + "Country") }.Where(v => v.Length > 0)));
        var latitude = Values(exif + "GPSLatitude");
        var longitude = Values(exif + "GPSLongitude");
        if (latitude.Length > 0 && longitude.Length > 0) Add("GPS", latitude + ", " + longitude);
        return rows;
    }
}
