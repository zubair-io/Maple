using System;
using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>One node in a Sidebar's source/page tree.</summary>
    public sealed record MuiSidebarNode(
        string Id, string Label, string IconName,
        IReadOnlyList<MuiSidebarNode>? Children = null, int? Count = null, bool Loading = false);

    /// <summary>One visible row after flattening — what
    /// <see cref="MuiSidebar"/> hands to a <see cref="MuiTreeRow"/>.
    /// </summary>
    public sealed record MuiSidebarFlatRow(MuiSidebarNode Node, int Depth, bool Expandable, bool Expanded);

    /// <summary>
    /// The tree-to-flat-list logic behind <see cref="MuiSidebar"/>
    /// (unified-component-catalog.md §4.2, "Sidebar" row: "Hierarchical
    /// source / page tree", built from Tree Row — this wave's brief calls
    /// for "a flattened depth list of MuiTreeRows"). A depth-first walk
    /// that only descends into a node's children once that node's id is
    /// in <paramref name="expandedIds"/> — collapsed branches contribute
    /// nothing to the result, so a real vertical StackPanel of
    /// <see cref="MuiTreeRow"/>s (this wave's "simplest compile-safe"
    /// choice, same as <see cref="MuiCollectionGrid"/>'s own reasoning)
    /// only ever renders what's actually visible. Pure over plain
    /// records — unit tested without a live Window.
    /// </summary>
    public static class MuiSidebarFlatten
    {
        public static IReadOnlyList<MuiSidebarFlatRow> Flatten(
            IReadOnlyList<MuiSidebarNode> roots, IReadOnlySet<string> expandedIds)
        {
            var result = new List<MuiSidebarFlatRow>();
            Walk(roots, 0, expandedIds, result);
            return result;
        }

        private static void Walk(
            IReadOnlyList<MuiSidebarNode> nodes, int depth,
            IReadOnlySet<string> expandedIds, List<MuiSidebarFlatRow> result)
        {
            foreach (var node in nodes)
            {
                var children = node.Children ?? Array.Empty<MuiSidebarNode>();
                var expandable = children.Count > 0;
                var expanded = expandable && expandedIds.Contains(node.Id);
                result.Add(new MuiSidebarFlatRow(node, depth, expandable, expanded));
                if (expanded) Walk(children, depth + 1, expandedIds, result);
            }
        }
    }
}
