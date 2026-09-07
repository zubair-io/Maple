using System;
using System.Collections.Generic;
using System.Globalization;

namespace Maple.WinUI
{
    /// <summary>What activating a filmstrip-rail cell resolves to: the photo
    /// to select (null when the tap changes nothing — the cell is already
    /// current, or the id isn't in the strip) and the shell mode to be in
    /// afterwards.</summary>
    public readonly record struct FilmstripActivation<T>(ShellMode Mode, T? Photo) where T : class;

    /// <summary>
    /// Pure, WinUI-free rules behind the viewer's filmstrip rail (#3402,
    /// MainWindow.Filmstrip.cs). Generic over the photo type for the same
    /// reason <see cref="ViewModels.SelectionLogic"/> is: it links into
    /// Maple.WinUI.Tests with a plain <c>string</c> stand-in.
    ///
    /// Cell ids are the photo's ordinal in the strip snapshot the rail was
    /// built from (<see cref="IdAt"/>), not its path: a rename changes
    /// <c>PhotoItem.FilePath</c> under a live strip, and the rail already
    /// rebuilds whenever the photo list itself changes, so position is the
    /// one key that stays valid for the snapshot's whole lifetime.
    /// </summary>
    public static class ViewerFilmstripLogic
    {
        /// <summary>The rail is viewer chrome: mounted in both Preview and
        /// Edit (same instance, same left-edge position), never in Browse,
        /// whose grid is the picker.</summary>
        public static bool IsRailVisible(ShellMode mode) => mode is ShellMode.Preview or ShellMode.Edit;

        /// <summary>The cell id for the photo at <paramref name="index"/>.</summary>
        public static string IdAt(int index) => index.ToString(CultureInfo.InvariantCulture);

        /// <summary>Passive culling status from the photo, with no editable
        /// controls in the navigation strip. One compact badge fits the Sm
        /// thumbnail and preserves the old filmstrip's rating/pick context.</summary>
        public static IReadOnlyList<string> CullingBadgesFor(int rating, string? flag)
        {
            var stars = new string('★', Math.Clamp(rating, 0, 5));
            var mark = flag == "pick" ? "✓" : flag == "reject" ? "×" : string.Empty;
            var badge = string.Join(" ", new[] { stars, mark }).Trim();
            return badge.Length == 0 ? Array.Empty<string>() : new[] { badge };
        }

        /// <summary>The cell id the rail should mark active for
        /// <paramref name="selected"/>, or null when nothing is selected or
        /// the selection isn't in this strip.</summary>
        public static string? ActiveIdFor<T>(IReadOnlyList<T> photos, T? selected) where T : class
        {
            if (selected is null) return null;
            for (var i = 0; i < photos.Count; i++)
                if (EqualityComparer<T>.Default.Equals(photos[i], selected)) return IdAt(i);
            return null;
        }

        /// <summary>Resolves a cell activation. A filmstrip tap is a
        /// selection change on the surface the user is already looking at:
        /// Preview stays Preview, Edit stays Edit — the mode comes back
        /// unchanged by contract, so the shell never re-enters or leaves a
        /// surface because of the strip.</summary>
        public static FilmstripActivation<T> Activate<T>(
            ShellMode mode, IReadOnlyList<T> photos, string id, T? current) where T : class
        {
            var photo = int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var index)
                && index < photos.Count
                    ? photos[index]
                    : null;
            var next = photo is null || EqualityComparer<T>.Default.Equals(photo, current) ? null : photo;
            return new FilmstripActivation<T>(mode, next);
        }
    }
}
