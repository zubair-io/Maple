using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free keyboard-navigation math shared by the Maple.UI
    /// overlay menus (unified-component-catalog.md §2.4: Context/Suggestion/
    /// Command Menu). Same split as <see cref="MuiSliderMath"/> — linkable
    /// into Maple.WinUI.Tests without a live Window.
    /// </summary>
    public static class MuiMenuNavMath
    {
        /// <summary>Advances <paramref name="current"/> by
        /// <paramref name="delta"/> with wraparound across
        /// <paramref name="count"/> items — the plain "every row is
        /// navigable" case (Suggestion Menu, Command Menu's filtered list).
        /// Returns 0 for a non-positive count.</summary>
        public static int WrapIndex(int current, int delta, int count)
        {
            if (count <= 0) return 0;
            return ((current + delta) % count + count) % count;
        }

        /// <summary>Advances the active index across only the given
        /// <paramref name="selectable"/> indexes — Context Menu's "skip
        /// dividers and disabled rows" navigation. <paramref name="current"/>
        /// is the previous active index (may itself be unselectable, e.g.
        /// -1 before the first move); <paramref name="direction"/> is +1 or
        /// -1. Ports `mui-context-menu.component.ts`'s `moveActive`.
        /// Returns -1 when nothing is selectable.</summary>
        public static int MoveActive(int current, int direction, IReadOnlyList<int> selectable)
        {
            if (selectable.Count == 0) return -1;

            var currentPos = -1;
            for (var i = 0; i < selectable.Count; i++)
            {
                if (selectable[i] != current) continue;
                currentPos = i;
                break;
            }

            var nextPos = currentPos == -1
                ? (direction > 0 ? 0 : selectable.Count - 1)
                : ((currentPos + direction) % selectable.Count + selectable.Count) % selectable.Count;
            return selectable[nextPos];
        }
    }
}
