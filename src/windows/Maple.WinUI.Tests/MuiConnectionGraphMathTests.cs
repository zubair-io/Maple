// MuiConnectionGraphMathTests — the pure static layout math behind the
// Maple.UI Connection Graph data plot
// (Maple.WinUI/MapleUI/Molecules/MuiConnectionGraphMath.cs, wave N3b of the
// Windows Maple.UI molecules, #3012). No WinUI/live Window involved. Covers
// layout determinism specifically: the same node/width/height always
// produces the same pixel position, with no force simulation or randomness
// involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiConnectionGraphMathTests
    {
        [Fact]
        public void ToPixel_ScalesNormalizedPositionByWidthAndHeight()
        {
            var node = new MuiConnectionGraphNode("a", "A", 0.25, 0.75);
            var (x, y) = MuiConnectionGraphMath.ToPixel(node, width: 200, height: 100);
            Assert.Equal(50, x);
            Assert.Equal(75, y);
        }

        [Fact]
        public void ToPixel_SameInputs_AlwaysProduceTheSamePosition()
        {
            var node = new MuiConnectionGraphNode("a", "A", 0.4, 0.6);
            var first = MuiConnectionGraphMath.ToPixel(node, 160, 96);
            for (var i = 0; i < 20; i++)
            {
                var repeat = MuiConnectionGraphMath.ToPixel(node, 160, 96);
                Assert.Equal(first, repeat); // deterministic: no force sim, no randomness
            }
        }

        [Fact]
        public void ToPixel_OutOfRangeCoordinates_PassThroughUnclamped()
        {
            var node = new MuiConnectionGraphNode("a", "A", 1.5, -0.5);
            var (x, y) = MuiConnectionGraphMath.ToPixel(node, width: 100, height: 100);
            Assert.Equal(150, x);
            Assert.Equal(-50, y);
        }

        [Fact]
        public void ToPixel_ZeroSize_CollapsesToOrigin()
        {
            var node = new MuiConnectionGraphNode("a", "A", 0.5, 0.5);
            var (x, y) = MuiConnectionGraphMath.ToPixel(node, width: 0, height: 0);
            Assert.Equal(0, x);
            Assert.Equal(0, y);
        }

        [Fact]
        public void IndexById_DuplicateId_KeepsLastOccurrence()
        {
            var nodes = new List<MuiConnectionGraphNode>
            {
                new("a", "First", 0.1, 0.1),
                new("a", "Second", 0.9, 0.9),
            };
            var index = MuiConnectionGraphMath.IndexById(nodes);
            Assert.Single(index);
            Assert.Equal("Second", index["a"].Label);
        }

        [Fact]
        public void IndexById_LooksUpEveryDistinctNode()
        {
            var nodes = new List<MuiConnectionGraphNode> { new("a", "A", 0, 0), new("b", "B", 1, 1) };
            var index = MuiConnectionGraphMath.IndexById(nodes);
            Assert.Equal(2, index.Count);
            Assert.True(index.ContainsKey("a"));
            Assert.True(index.ContainsKey("b"));
        }

        [Fact]
        public void IndexById_MissingId_IsAbsentFromIndex()
        {
            var nodes = new List<MuiConnectionGraphNode> { new("a", "A", 0, 0) };
            var index = MuiConnectionGraphMath.IndexById(nodes);
            Assert.False(index.ContainsKey("missing"));
        }
    }
}
