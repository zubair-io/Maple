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
        /// <summary>A local folder passes <paramref name="requireSharedSidecar"/>:
        /// names the pairing rule folds but whose files read two different
        /// sidecars stay two tiles.</summary>
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
            return (requireSharedSidecar ? RawJpegPairing.LocalPairs(byPath.Keys) : RawJpegPairing.Pairs(byPath.Keys))
                .ToDictionary(pair => byPath[pair.Key], pair => byPath[pair.Value]);
        }

        /// <summary>Whether a listing folds pairs. A local folder follows the
        /// device-local Settings switch; a cloud folder only its server's flag;
        /// an active format filter turns folding off for both, as the server
        /// does while an extension filter is active, so a JPG filter still
        /// lists the JPEG of a pair.</summary>
        public static bool ShouldFold(
            bool inLocalFolder, bool localSwitchOn, bool inCloudFolder, bool serverFoldsPairs,
            bool formatFilterActive) =>
            !formatFilterActive && ((inLocalFolder && localSwitchOn) || (inCloudFolder && serverFoldsPairs));

        public static bool IsFormatFilterActive(string formatFilter) => formatFilter != "All";

        public static IEnumerable<PhotoItem> Tiles(IEnumerable<PhotoItem> photos) =>
            photos.Where(photo => photo.StackPrimary == null);

        public static PhotoItem TileOf(PhotoItem photo) => photo.StackPrimary ?? photo;

        public static IReadOnlyList<PhotoItem> WithCompanions(IEnumerable<PhotoItem> tiles) =>
            tiles.SelectMany(tile => tile.StackCompanion is { } companion
                ? new[] { tile, companion }
                : new[] { tile }).ToList();
    }
}
