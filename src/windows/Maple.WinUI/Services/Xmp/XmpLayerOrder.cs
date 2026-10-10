// XmpLayerOrder — `papp:LayerOrder` (#4427): each correction's position in
// the full local-adjustment stack, so an interleaved stack survives the
// per-kind containers. `docs/xmp-canonical-format.md` § "Local adjustments"
// is the contract.
//
// Windows re-emits Maple's brush container and unmodelled group corrections
// from their source text, never rewriting their keys. Modeled layers keep the
// keys they were read with wherever the order allows and slot new or moved
// layers between their neighbours, so in-memory keys stay valid across saves
// and an edit never moves a layer across a verbatim correction.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    internal static class XmpLayerOrder
    {
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;
        private static readonly string LocalName =
            LocalMaskWire.LAYER_ORDER_ATTRIBUTE[(LocalMaskWire.LAYER_ORDER_ATTRIBUTE.IndexOf(':') + 1)..];

        internal static double? Read(XElement description)
        {
            var raw = (description.Attribute((XNamespace)XmpSchema.PappNs + LocalName)
                ?? description.Attribute((XNamespace)XmpSchema.PappNsLegacy + LocalName))?.Value;
            return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var key)
                && double.IsFinite(key) ? key : null;
        }

        internal static bool IsBrushContainer(XElement child) =>
            XmpSchema.IsPappUri(child.Name.NamespaceName) && child.Name.LocalName == "BrushCorrections";

        internal static IEnumerable<XElement> ContainerItems(XElement container) =>
            container.Elements(Rdf + "Seq").Elements(Rdf + "li");

        internal static IEnumerable<double> Keys(IEnumerable<XElement> items) =>
            items.Elements(Rdf + "Description").Select(Read).OfType<double>();

        internal static List<LocalAdjustment> Sorted(List<LocalAdjustment> layers) =>
            layers.Count > 0 && layers.All(layer => layer.XmpLayerOrder is not null)
                ? layers.OrderBy(layer => layer.XmpLayerOrder!.Value).ToList()
                : layers;

        private static int ContainerRank(LocalMask mask) => mask switch
        {
            LinearMask => 0,
            RadialMask => 1,
            _ => 3,
        };

        /// <summary>
        /// With no keyed verbatim correction, keys are model indexes, written
        /// only for an interleaved stack. Otherwise every layer gets a key: a
        /// longest increasing run of read keys is kept, and each other layer
        /// takes a key between its model predecessor and the next kept layer
        /// or verbatim correction above it.
        /// </summary>
        internal static IReadOnlyList<(LocalAdjustment Layer, double? Order)> Assign(
            IReadOnlyList<LocalAdjustment> layers, IReadOnlyList<double> verbatim)
        {
            if (verbatim.Count == 0)
            {
                var ranks = layers.Select(layer => ContainerRank(layer.Mask)).ToArray();
                var interleaved = ranks.Zip(ranks.Skip(1)).Any(pair => pair.First > pair.Second);
                return layers.Select((layer, index) => (layer, interleaved ? index : (double?)null)).ToArray();
            }
            var kept = KeptIndexes(layers.Select(layer => layer.XmpLayerOrder).ToArray());
            var keys = layers.Select((layer, index) => (layer, index)).Aggregate(new List<double>(), (assigned, entry) =>
            {
                double? lower = assigned.Count == 0 ? null : assigned[^1];
                var bounds = kept.Where(index => index > entry.index).Select(index => layers[index].XmpLayerOrder!.Value)
                    .Concat(verbatim.Where(key => lower is null || key > lower));
                double? upper = bounds.Any() ? bounds.Min() : null;
                assigned.Add(kept.Contains(entry.index) ? entry.layer.XmpLayerOrder!.Value : (lower, upper) switch
                {
                    (null, null) => 0,
                    (null, { } above) => above - 1,
                    ({ } below, null) => Math.Floor(below) + 1,
                    ({ } below, { } above) => (below + above) / 2,
                });
                return assigned;
            });
            var written = Representable(keys, verbatim) ? keys : Respaced(keys, verbatim);
            return layers.Zip(written, (layer, key) => (layer, (double?)key)).ToArray();
        }

        private static double Written(double key) => double.Parse(Format(key), CultureInfo.InvariantCulture);

        /// <summary>
        /// Repeated midpoints can halve a gap below the six-decimal codec, so
        /// the written keys must still order the layers and verbatim corrections
        /// exactly as the unrounded ones do.
        /// </summary>
        private static bool Representable(IReadOnlyList<double> keys, IReadOnlyList<double> verbatim)
        {
            var written = keys.Select(Written).ToArray();
            return written.Zip(written.Skip(1)).All(pair => pair.First < pair.Second)
                && keys.Zip(written).All(pair => verbatim.All(key =>
                    Math.Sign(pair.Second - key) != 0 && Math.Sign(pair.Second - key) == Math.Sign(pair.First - key)));
        }

        /// <summary>Evenly re-spaced keys for each run of layers between the same two verbatim corrections.</summary>
        private static IReadOnlyList<double> Respaced(IReadOnlyList<double> keys, IReadOnlyList<double> verbatim)
        {
            var sorted = verbatim.OrderBy(key => key).ToArray();
            return keys.Select((key, index) => (index, gap: verbatim.Count(other => other < key)))
                .GroupBy(entry => entry.gap)
                .SelectMany(group =>
                {
                    var members = group.ToArray();
                    double? low = group.Key > 0 ? sorted[group.Key - 1] : null;
                    double? high = group.Key < sorted.Length ? sorted[group.Key] : null;
                    var count = members.Length;
                    return members.Select((member, rank) => (member.index, key: (low, high) switch
                    {
                        ({ } below, { } over) => below + (over - below) * (rank + 1) / (count + 1),
                        (null, { } over) => over - count + rank,
                        ({ } below, null) => Math.Floor(below) + 1 + rank,
                        _ => (double)rank,
                    }));
                })
                .OrderBy(entry => entry.index)
                .Select(entry => entry.key)
                .ToArray();
        }

        /// <summary>
        /// A longest strictly increasing subsequence of `keys`: the smallest
        /// predecessor on ties, ending at the latest layer of maximal length.
        /// </summary>
        private static HashSet<int> KeptIndexes(IReadOnlyList<double?> keys)
        {
            var chains = keys.Select((_, index) => index).Aggregate(new List<(int Length, int Previous)>(), (acc, index) =>
            {
                var below = keys[index] is { } key
                    ? Enumerable.Range(0, index).Where(earlier => keys[earlier] is { } other && other < key).ToArray()
                    : null;
                var longest = below is null || below.Length == 0 ? 0 : below.Max(earlier => acc[earlier].Length);
                acc.Add(below is null ? (0, -1)
                    : (longest + 1, longest == 0 ? -1 : below.First(earlier => acc[earlier].Length == longest)));
                return acc;
            });
            var best = chains.Select(chain => chain.Length).DefaultIfEmpty(0).Max();
            if (best == 0) return new HashSet<int>();
            var end = chains.FindLastIndex(chain => chain.Length == best);
            IEnumerable<int> Walk(int index) => index < 0 ? Enumerable.Empty<int>() : Walk(chains[index].Previous).Append(index);
            return Walk(end).ToHashSet();
        }

        internal static string Format(double key) => XmpLocalAdjustments.FormatCoordinate(key);
    }
}
