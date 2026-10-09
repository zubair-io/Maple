using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Xml.Linq;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    /// <summary>Opaque source fragments interleaved with stable modeled layer slots.</summary>
    internal sealed class XmpMaskGroupTemplate
    {
        private sealed record Part(string? Xml = null, int? Slot = null, bool Append = false);
        private readonly List<Part> parts;
        private readonly bool acceptsNew;
        private XmpMaskGroupTemplate(List<Part> parts, bool acceptsNew)
        {
            this.parts = parts;
            this.acceptsNew = acceptsNew;
        }

        private IEnumerable<int> Slots => parts.Where(part => part.Slot is not null).Select(part => part.Slot!.Value);
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;

        internal static void Capture(XElement container, string source, XmpSidecarDocument doc)
        {
            var span = XmpGroupSource.ElementSpan(container, source);
            var sequences = container.Elements(Rdf + "Seq").ToArray();
            var parts = new List<Part>();
            var canAppend = sequences.Length == 1 && !sequences[0].IsEmpty;
            if (!canAppend)
            {
                doc.VerbatimLayerOrders.AddRange(XmpLayerOrder.Keys(sequences.Elements(Rdf + "li")));
                parts.Add(new Part(Xml: XmpGroupSource.ScopeOpening(source[span.Start..span.End], container)));
            }
            else
            {
                var seq = sequences[0];
                var seqSpan = XmpGroupSource.ElementSpan(seq, source);
                var cursor = span.Start;
                var nextSlot = doc.MaskGroups.SelectMany(group => group.Slots).DefaultIfEmpty(-1).Max() + 1;
                foreach (var li in seq.Elements(Rdf + "li"))
                {
                    var layer = XmpLocalAdjustments.ParseGroupCorrection(li);
                    if (layer is null)
                    {
                        doc.VerbatimLayerOrders.AddRange(XmpLayerOrder.Keys(new[] { li }));
                        continue;
                    }
                    var liSpan = XmpGroupSource.ElementSpan(li, source);
                    parts.Add(new Part(Xml: source[cursor..liSpan.Start]));
                    parts.Add(new Part(Slot: nextSlot));
                    doc.Adjustments.LocalAdjustments.Add(layer with { XmpGroupSlot = nextSlot++ });
                    cursor = liSpan.End;
                }
                var closing = source.LastIndexOf("</", seqSpan.End - 1, seqSpan.End - seqSpan.Start, StringComparison.Ordinal);
                parts.Add(new Part(Xml: source[cursor..closing]));
                parts.Add(new Part(Append: true));
                parts.Add(new Part(Xml: source[closing..span.End]));
                parts[0] = parts[0] with { Xml = XmpGroupSource.ScopeOpening(parts[0].Xml!, container) };
            }
            var index = doc.MaskGroups.Count;
            doc.MaskGroups.Add(new XmpMaskGroupTemplate(parts, canAppend));
            doc.ChildOrder.Add(ChildSlot.ForModeled(Key(index)));
        }

        private static string Key(int index) => XmpLocalAdjustments.GroupContainer + ":" + index;

        private string Render(IReadOnlyList<(LocalAdjustment Layer, double? Order)> keyed,
            IReadOnlyList<(LocalAdjustment Layer, double? Order)> fresh, string indent)
        {
            var bySlot = keyed.Where(entry => entry.Layer.Mask is MaskGroup && entry.Layer.XmpGroupSlot is not null)
                .GroupBy(entry => entry.Layer.XmpGroupSlot!.Value).ToDictionary(group => group.Key, group => group.First());
            var output = new StringBuilder(indent);
            foreach (var part in parts)
            {
                if (part.Xml is { } xml) output.Append(xml);
                else if (part.Slot is { } slot && bySlot.TryGetValue(slot, out var entry))
                    output.Append(XmpLocalAdjustments.GroupCorrection(entry.Layer, entry.Order));
                else if (part.Append)
                    foreach (var added in fresh) output.Append(XmpLocalAdjustments.GroupCorrection(added.Layer, added.Order));
            }
            return output.ToString();
        }

        internal static IEnumerable<(string Tag, string? Block)> Blocks(XmpSidecarDocument doc,
            IReadOnlyList<(LocalAdjustment Layer, double? Order)> keyed, string indent)
        {
            foreach (var tag in new[] { XmpLocalAdjustments.LinearContainer, XmpLocalAdjustments.RadialContainer })
                yield return (tag, XmpLocalAdjustments.Block(tag, keyed, indent));
            if (doc.MaskGroups.Count == 0)
            {
                yield return (XmpLocalAdjustments.GroupContainer, XmpLocalAdjustments.Block(XmpLocalAdjustments.GroupContainer, keyed, indent));
                yield break;
            }
            var claimed = doc.MaskGroups.SelectMany(group => group.Slots).ToHashSet();
            var fresh = keyed.Where(entry => entry.Layer.Mask is MaskGroup
                && (entry.Layer.XmpGroupSlot is null || !claimed.Contains(entry.Layer.XmpGroupSlot.Value))).ToArray();
            var appendTo = doc.MaskGroups.FindLastIndex(group => group.acceptsNew);
            if (appendTo < 0)
                yield return (XmpLocalAdjustments.GroupContainer, XmpLocalAdjustments.Block(XmpLocalAdjustments.GroupContainer, fresh, indent));
            for (var index = 0; index < doc.MaskGroups.Count; index++)
                yield return (Key(index), doc.MaskGroups[index].Render(keyed,
                    index == appendTo ? fresh : Array.Empty<(LocalAdjustment, double?)>(), indent));
        }
    }
}
