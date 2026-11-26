// RawJpegStackFold.cs — folds each RAW+JPEG pair of the browsed folder into
// the RAW's one tile (#5050, #5848). Every file stays a PhotoItem, so the
// folder watcher and the cloud listing keep adding and removing plain files;
// the fold is recomputed from them. WinUI-free, linked into Maple.WinUI.Tests.

using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public static class RawJpegStackFold
    {
        /// <summary>Links each pair (<see cref="PhotoItem.StackCompanion"/> on
        /// the RAW, <see cref="PhotoItem.StackPrimary"/> on the JPEG), clears
        /// links that no longer hold, and returns the photos that keep a tile,
        /// in their given order. With <paramref name="stacksPairs"/> off every
        /// file is its own tile. A local folder passes
        /// <paramref name="requireSharedSidecar"/>: names the pairing rule
        /// folds but whose files read two different sidecars stay two
        /// tiles.</summary>
        public static IReadOnlyList<PhotoItem> Apply(
            IReadOnlyList<PhotoItem> photos, bool stacksPairs, bool requireSharedSidecar = false)
        {
            var companionOf = stacksPairs ? Pair(photos, requireSharedSidecar) : new Dictionary<PhotoItem, PhotoItem>();
            var primaryOf = companionOf.ToDictionary(pair => pair.Value, pair => pair.Key);
            foreach (var photo in photos)
            {
                photo.StackCompanion = companionOf.GetValueOrDefault(photo);
                photo.StackPrimary = primaryOf.GetValueOrDefault(photo);
            }
            return photos.Where(photo => photo.StackPrimary == null).ToList();
        }

        private static Dictionary<PhotoItem, PhotoItem> Pair(IReadOnlyList<PhotoItem> photos, bool requireSharedSidecar)
        {
            var byPath = photos
                .GroupBy(photo => photo.FilePath, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
            return RawJpegPairing.Pairs(byPath.Keys)
                .Where(pair => !requireSharedSidecar || LocalFileOperations.SharesOneSidecar(pair.Key, pair.Value))
                .ToDictionary(pair => byPath[pair.Key], pair => byPath[pair.Value]);
        }

        public static IEnumerable<PhotoItem> Tiles(IEnumerable<PhotoItem> photos) =>
            photos.Where(photo => photo.StackPrimary == null);

        /// <summary>The tile that shows <paramref name="photo"/>: itself, or
        /// the RAW a folded JPEG rides on.</summary>
        public static PhotoItem TileOf(PhotoItem photo) => photo.StackPrimary ?? photo;

        /// <summary>The photos whose files an action on these tiles reaches:
        /// each tile, then its folded JPEG.</summary>
        public static IReadOnlyList<PhotoItem> WithCompanions(IEnumerable<PhotoItem> tiles) =>
            tiles.SelectMany(tile => tile.StackCompanion is { } companion
                ? new[] { tile, companion }
                : new[] { tile }).ToList();
    }
}
