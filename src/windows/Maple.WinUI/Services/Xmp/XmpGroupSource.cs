using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace Maple.WinUI.Services.Xmp
{
    /// <summary>Ranges in the original XML, so opaque pins retain their bytes.</summary>
    internal static class XmpGroupSource
    {
        internal readonly record struct Span(int Start, int End);

        internal static Span ElementSpan(XElement element, string source)
        {
            var info = (IXmlLineInfo)element;
            if (!info.HasLineInfo()) throw new ArgumentException("Source line information is required");
            var offset = 0;
            for (var line = 1; line < info.LineNumber; line++)
            {
                while (offset < source.Length && source[offset] != '\n' && source[offset] != '\r') offset++;
                if (offset < source.Length && source[offset++] == '\r'
                    && offset < source.Length && source[offset] == '\n') offset++;
            }
            var name = offset + info.LinePosition - 1;
            var start = source.LastIndexOf('<', name);
            var cursor = start;
            var depth = 0;
            while (cursor < source.Length)
            {
                var open = source.IndexOf('<', cursor);
                if (open < 0) break;
                if (source.AsSpan(open).StartsWith("<!--"))
                {
                    cursor = source.IndexOf("-->", open, StringComparison.Ordinal) + 3;
                    continue;
                }
                if (source.AsSpan(open).StartsWith("<![CDATA["))
                {
                    cursor = source.IndexOf("]]>", open, StringComparison.Ordinal) + 3;
                    continue;
                }
                if (source.AsSpan(open).StartsWith("<?"))
                {
                    cursor = source.IndexOf("?>", open, StringComparison.Ordinal) + 2;
                    continue;
                }
                var end = HeaderEnd(source, open);
                var closing = source[open + 1] == '/';
                var empty = source[end - 2] == '/';
                depth += closing ? -1 : empty ? 0 : 1;
                if (depth == 0) return new Span(start, end);
                cursor = end;
            }
            throw new ArgumentException("Element is not complete in the parsed source");
        }

        internal static int HeaderEnd(string source, int start)
        {
            var quote = '\0';
            for (var i = start + 1; i < source.Length; i++)
            {
                var ch = source[i];
                if (quote != '\0')
                {
                    if (ch == quote) quote = '\0';
                }
                else if (ch == '\'' || ch == '"') quote = ch;
                else if (ch == '>') return i + 1;
            }
            throw new ArgumentException("Unterminated element header");
        }

        internal static string ScopeOpening(string raw, XElement container)
        {
            var own = container.Attributes().Where(a => a.IsNamespaceDeclaration).Select(a => a.Name).ToHashSet();
            var inherited = container.Ancestors().SelectMany(e => e.Attributes())
                .Where(a => a.IsNamespaceDeclaration).DistinctBy(a => a.Name)
                .Where(a => !own.Contains(a.Name) && !CanonicalBinding(a));
            var declarations = string.Concat(inherited.Select(a =>
                $" {a.Name.LocalName switch { "xmlns" => "xmlns", var prefix => "xmlns:" + prefix }}=\"{XmpSchema.EscapeAttr(a.Value)}\""));
            var end = HeaderEnd(raw, 0) - 1;
            var insert = raw[end - 1] == '/' ? end - 1 : end;
            return raw.Insert(insert, declarations);
        }

        // These exact bindings are already declared by XmpWriter. Omitting
        // redundant inherited declarations also keeps a second save stable.
        internal static bool CanonicalBinding(XAttribute attribute) => attribute.Name.LocalName switch
        {
            "x" => attribute.Value == "adobe:ns:meta/",
            "rdf" => attribute.Value == XmpSchema.RdfNs,
            "xmp" => attribute.Value == XmpSchema.XmpNs,
            "crs" => attribute.Value == XmpSchema.CrsNs,
            "papp" => attribute.Value == XmpSchema.PappNs,
            _ => false,
        };
    }
}
