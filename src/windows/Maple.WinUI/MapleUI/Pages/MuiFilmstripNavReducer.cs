using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free "move by N, wrap at the ends" logic
    /// shared by <c>MuiPagePreview</c> and <c>MuiPageTVViewer</c> (#3012)
    /// — both pages step a Preview Surface's active asset from its
    /// Filmstrip/remote-control input, and both need the same
    /// wrap-around behavior (advancing past the last item lands back on
    /// the first, same for stepping back past the first) rather than
    /// duplicating the index math per page.</summary>
    public static class MuiFilmstripNavReducer
    {
        /// <summary>Returns the id <paramref name="delta"/> steps away
        /// from <paramref name="activeId"/> in <paramref name="ids"/>,
        /// wrapping around either end. An empty list yields null; an
        /// unrecognized <paramref name="activeId"/> is treated as index
        /// 0 before stepping.</summary>
        public static string? Move(IReadOnlyList<string> ids, string? activeId, int delta)
        {
            if (ids.Count == 0) return null;

            var index = 0;
            for (var i = 0; i < ids.Count; i++)
            {
                if (ids[i] != activeId) continue;
                index = i;
                break;
            }

            var next = ((index + delta) % ids.Count + ids.Count) % ids.Count;
            return ids[next];
        }
    }
}
