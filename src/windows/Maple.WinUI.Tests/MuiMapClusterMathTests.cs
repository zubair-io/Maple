// MuiMapClusterMathTests — the pin-clustering math behind the Maple.UI
// Map Surface organism (Maple.WinUI/MapleUI/Organisms/MuiMapClusterMath.cs,
// wave N6, #3012). No WinUI/live Window involved.

using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiMapClusterMathTests
    {
        [Fact]
        public void Cluster_EmptyInput_ReturnsEmpty()
        {
            Assert.Empty(MuiMapClusterMath.Cluster(System.Array.Empty<MuiMapPoint>(), 10));
        }

        [Fact]
        public void Cluster_SinglePoint_ReturnsOneClusterOfOne()
        {
            var result = MuiMapClusterMath.Cluster(new[] { new MuiMapPoint("a", 10, 10) }, 5);
            Assert.Single(result);
            Assert.Equal(1, result[0].Count);
        }

        [Fact]
        public void Cluster_TwoPointsWithinRadius_Merge()
        {
            var points = new[] { new MuiMapPoint("a", 0, 0), new MuiMapPoint("b", 3, 4) }; // distance 5
            var result = MuiMapClusterMath.Cluster(points, 10);
            Assert.Single(result);
            Assert.Equal(2, result[0].Count);
        }

        [Fact]
        public void Cluster_TwoPointsOutsideRadius_StaySeparate()
        {
            var points = new[] { new MuiMapPoint("a", 0, 0), new MuiMapPoint("b", 100, 100) };
            var result = MuiMapClusterMath.Cluster(points, 5);
            Assert.Equal(2, result.Count);
        }

        [Fact]
        public void Cluster_CentroidIsAverageOfMembers()
        {
            var points = new[] { new MuiMapPoint("a", 0, 0), new MuiMapPoint("b", 10, 0) };
            var result = MuiMapClusterMath.Cluster(points, 20);
            Assert.Single(result);
            Assert.Equal(5, result[0].X);
            Assert.Equal(0, result[0].Y);
        }

        [Fact]
        public void Cluster_EveryPointIsAccountedForExactlyOnce()
        {
            var points = Enumerable.Range(0, 20).Select(i => new MuiMapPoint($"p{i}", i * 2, 0)).ToList();
            var result = MuiMapClusterMath.Cluster(points, 3);
            var allMembers = result.SelectMany(c => c.MemberIds).ToList();
            Assert.Equal(20, allMembers.Count);
            Assert.Equal(20, allMembers.Distinct().Count());
        }

        [Fact]
        public void Cluster_ZeroRadius_NeverMergesDistinctPoints()
        {
            var points = new[] { new MuiMapPoint("a", 0, 0), new MuiMapPoint("b", 0.5, 0) };
            var result = MuiMapClusterMath.Cluster(points, 0);
            Assert.Equal(2, result.Count);
        }

        [Fact]
        public void Cluster_ThreeCollinearPointsWithinRadius_AllMergeIntoOne()
        {
            var points = new[] { new MuiMapPoint("a", 0, 0), new MuiMapPoint("b", 5, 0), new MuiMapPoint("c", 10, 0) };
            var result = MuiMapClusterMath.Cluster(points, 100);
            Assert.Single(result);
            Assert.Equal(3, result[0].Count);
        }
    }
}
