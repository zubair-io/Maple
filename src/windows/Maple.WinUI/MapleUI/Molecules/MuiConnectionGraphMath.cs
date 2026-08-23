using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>One node in a Connection Graph — position is normalized
    /// 0..1 within the plot.</summary>
    public sealed record MuiConnectionGraphNode(string Id, string Label, double X, double Y);

    /// <summary>One link between two node ids.</summary>
    public sealed record MuiConnectionGraphLink(string Source, string Target);

    /// <summary>
    /// Plain, WinUI-free layout math behind the Maple.UI Connection Graph
    /// data plot (unified-component-catalog.md §2.6) — a STATIC (force-free)
    /// node-link graph: the caller supplies each node's normalized position
    /// directly, this only scales to pixels and resolves links. Same split
    /// as <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests
    /// without a live Window. Deterministic by construction: the same
    /// node/width/height always produces the same pixel position, matching
    /// `mui-connection-graph.component.ts`'s own `x * w, y * h` scaling with
    /// no force simulation or randomness involved.
    /// </summary>
    public static class MuiConnectionGraphMath
    {
        /// <summary>Scales a node's normalized (0..1) position into plot-
        /// local pixel space. Coordinates outside [0,1] pass through
        /// unclamped (matches the web component — an out-of-range node is
        /// the caller's data error, not this primitive's to hide).</summary>
        public static (double X, double Y) ToPixel(MuiConnectionGraphNode node, double width, double height) =>
            (node.X * width, node.Y * height);

        /// <summary>Indexes nodes by id for link resolution. A duplicate id
        /// keeps the LAST occurrence — matches `new Map(nodes.map(...))`'s
        /// last-write-wins semantics in the web component.</summary>
        public static IReadOnlyDictionary<string, MuiConnectionGraphNode> IndexById(IReadOnlyList<MuiConnectionGraphNode> nodes)
        {
            var map = new Dictionary<string, MuiConnectionGraphNode>();
            foreach (var node in nodes)
                map[node.Id] = node;
            return map;
        }
    }
}
