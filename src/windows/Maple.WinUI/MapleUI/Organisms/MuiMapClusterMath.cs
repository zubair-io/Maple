using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One geotagged asset, already projected to the map's own
    /// screen-space X/Y (the control's job, not this math's).</summary>
    public readonly record struct MuiMapPoint(string Id, double X, double Y);

    /// <summary>One cluster — its centroid plus every member id that fell
    /// within <c>radius</c> of it. A single-member cluster is just an
    /// unclustered pin.</summary>
    public sealed record MuiMapCluster(double X, double Y, IReadOnlyList<string> MemberIds)
    {
        public int Count => MemberIds.Count;
    }

    /// <summary>
    /// The pin-clustering math behind <see cref="MuiMapSurface"/>
    /// (unified-component-catalog.md §4.6, "Map Surface" row: "Clustered
    /// pins with density overlay"). Greedy single-pass grouping: each
    /// point joins the first existing cluster whose current centroid is
    /// within <c>radius</c> screen pixels, or starts a new one — O(points
    /// × clusters), which is the right trade for a UI-thread hit test at
    /// interactive pin counts (hundreds, not millions). Pure over
    /// <see cref="MuiMapPoint"/> — unit tested without a live Window; the
    /// control re-runs this on pan/zoom with a radius scaled to the
    /// current zoom level.
    /// </summary>
    public static class MuiMapClusterMath
    {
        public static IReadOnlyList<MuiMapCluster> Cluster(IReadOnlyList<MuiMapPoint> points, double radius)
        {
            var accumulators = new List<(double SumX, double SumY, List<string> Members)>();
            var radiusSquared = radius * radius;

            foreach (var point in points)
            {
                var placedIndex = -1;
                for (var i = 0; i < accumulators.Count; i++)
                {
                    var (sumX, sumY, members) = accumulators[i];
                    var centroidX = sumX / members.Count;
                    var centroidY = sumY / members.Count;
                    var dx = point.X - centroidX;
                    var dy = point.Y - centroidY;
                    if (dx * dx + dy * dy > radiusSquared) continue;
                    placedIndex = i;
                    break;
                }

                if (placedIndex >= 0)
                {
                    var (sumX, sumY, members) = accumulators[placedIndex];
                    members.Add(point.Id);
                    accumulators[placedIndex] = (sumX + point.X, sumY + point.Y, members);
                }
                else
                {
                    accumulators.Add((point.X, point.Y, new List<string> { point.Id }));
                }
            }

            return accumulators
                .Select(a => new MuiMapCluster(a.SumX / a.Members.Count, a.SumY / a.Members.Count, a.Members))
                .ToList();
        }
    }
}
