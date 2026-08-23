// MuiSidebarFlattenTests — the tree-to-flat-list logic behind the Maple.UI
// Sidebar organism (Maple.WinUI/MapleUI/Organisms/MuiSidebarFlatten.cs,
// wave N6, #3012). No WinUI/live Window involved.

using System.Collections.Generic;
using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSidebarFlattenTests
    {
        private static MuiSidebarNode Tree() => new(
            "root", "Root", "folder",
            Children: new[]
            {
                new MuiSidebarNode("a", "Folder A", "folder", Children: new[]
                {
                    new MuiSidebarNode("a1", "Nested A1", "folder"),
                }),
                new MuiSidebarNode("b", "Folder B", "folder"),
            });

        [Fact]
        public void Flatten_WithNoExpansion_OnlyShowsTopLevel()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string>());
            Assert.Equal(new[] { "root" }, rows.Select(r => r.Node.Id));
        }

        [Fact]
        public void Flatten_ExpandedRoot_ShowsItsChildren()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string> { "root" });
            Assert.Equal(new[] { "root", "a", "b" }, rows.Select(r => r.Node.Id));
        }

        [Fact]
        public void Flatten_ExpandedNestedNode_ShowsGrandchildren()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string> { "root", "a" });
            Assert.Equal(new[] { "root", "a", "a1", "b" }, rows.Select(r => r.Node.Id));
        }

        [Fact]
        public void Flatten_AssignsIncreasingDepth()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string> { "root", "a" });
            var byId = rows.ToDictionary(r => r.Node.Id, r => r.Depth);
            Assert.Equal(0, byId["root"]);
            Assert.Equal(1, byId["a"]);
            Assert.Equal(2, byId["a1"]);
            Assert.Equal(1, byId["b"]);
        }

        [Fact]
        public void Flatten_LeafNode_IsNotExpandable()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string> { "root" });
            Assert.False(rows.Single(r => r.Node.Id == "b").Expandable);
        }

        [Fact]
        public void Flatten_ParentNode_IsExpandableAndReflectsExpandedSet()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string> { "root" });
            var a = rows.Single(r => r.Node.Id == "a");
            Assert.True(a.Expandable);
            Assert.False(a.Expanded);
        }

        [Fact]
        public void Flatten_ExpandedIdOnLeaf_HasNoEffect()
        {
            var rows = MuiSidebarFlatten.Flatten(new[] { Tree() }, new HashSet<string> { "root", "b" });
            Assert.Equal(new[] { "root", "a", "b" }, rows.Select(r => r.Node.Id));
        }
    }
}
