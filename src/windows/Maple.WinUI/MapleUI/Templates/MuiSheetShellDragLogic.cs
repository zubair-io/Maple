using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>
    /// Pure detent/drag-threshold math behind <see cref="MuiSheetShell"/>
    /// — unit-tested without a live Window. Mirrors
    /// `sheet-drag.ts`'s pan-down-clamp/dismiss-distance contract.
    /// </summary>
    public static class MuiSheetShellDragLogic
    {
        /// <summary>Pan-down dismiss threshold as a fraction of the
        /// sheet's own height.</summary>
        public const double DismissFraction = 0.25;

        public static readonly IReadOnlyList<double> DefaultDetents = new double[] { 0.4, 0.9 };

        /// <summary>Clamps a drag's vertical offset to pan-down-only —
        /// these sheets dismiss by dragging down, so an upward drag is a
        /// no-op.</summary>
        public static double ClampPanDown(double dy) => dy > 0 ? dy : 0;

        /// <summary>True once a pan-down drag has crossed the dismiss
        /// distance. False for a not-yet-measured (zero-height)
        /// sheet.</summary>
        public static bool IsDistanceDismissed(double dy, double sheetHeight, double fraction) =>
            sheetHeight > 0 && dy >= sheetHeight * fraction;

        /// <summary>Resolves the active detent index to a height fraction,
        /// falling back to <see cref="DefaultDetents"/> when
        /// <paramref name="detents"/> is null/empty and to index 0 when
        /// <paramref name="activeDetent"/> is out of range.</summary>
        public static double HeightFraction(IReadOnlyList<double>? detents, int activeDetent)
        {
            var list = detents is { Count: > 0 } ? detents : DefaultDetents;
            var index = activeDetent >= 0 && activeDetent < list.Count ? activeDetent : 0;
            return list[index];
        }
    }
}
