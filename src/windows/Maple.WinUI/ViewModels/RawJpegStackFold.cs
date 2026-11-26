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
        /// sidecars stay two tiles. <paramref name="inventory"/> is every RAW
        /// and JPEG name in the folder, shown or not: a stem with a second RAW
        /// the grid does not list (`IMG.MEF`) is ambiguous and stays unpaired.</summary>
        public static IReadOnlyList<PhotoItem> Apply(
            IReadOnlyList<PhotoItem> photos, bool stacksPairs, bool requireSharedSidecar = false,
            IEnumerable<string>? inventory = null, bool? folderFoldsCase = null)
        {
            var companionOf = stacksPairs
                ? Pair(photos, requireSharedSidecar, inventory, folderFoldsCase)
                : new Dictionary<PhotoItem, PhotoItem>();
            var primaryOf = companionOf.ToDictionary(pair => pair.Value, pair => pair.Key);
            foreach (var photo in photos)
            {
                photo.StackCompanion = companionOf.GetValueOrDefault(photo);
                photo.StackPrimary = primaryOf.GetValueOrDefault(photo);
            }
            return photos.Where(photo => photo.StackPrimary == null).ToList();
        }

        private static Dictionary<PhotoItem, PhotoItem> Pair(
            IReadOnlyList<PhotoItem> photos, bool requireSharedSidecar, IEnumerable<string>? inventory, bool? folderFoldsCase)
        {
            var byPath = photos
                .GroupBy(photo => photo.FilePath, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
            var names = byPath.Keys.Concat(inventory ?? Enumerable.Empty<string>()).Distinct(StringComparer.Ordinal).ToList();
            var pairs = !requireSharedSidecar ? RawJpegPairing.Pairs(names)
                : folderFoldsCase is { } folds ? RawJpegPairing.LocalPairs(names, folds)
                : RawJpegPairing.LocalPairs(names);
            return pairs
                .Where(pair => byPath.ContainsKey(pair.Key) && byPath.ContainsKey(pair.Value))
                .ToDictionary(pair => byPath[pair.Key], pair => byPath[pair.Value]);
        }

        /// <summary>Whether a listing folds pairs. A local folder follows the
        /// device-local Settings switch; a cloud folder only its server's flag;
        /// an active format filter turns folding off for both, as the server
        /// does while an extension filter is active, so a JPG filter still
        /// lists the JPEG of a pair.</summary>
        public static bool ShouldFold(
            bool inLocalFolder, bool localSwitchOn, bool inCloudFolder, bool serverFoldsPairs,
            bool cloudListingComplete, bool formatFilterActive) =>
            !formatFilterActive
            && ((inLocalFolder && localSwitchOn) || (inCloudFolder && serverFoldsPairs && cloudListingComplete));

        /// <summary>A cloud listing is complete only when every page arrived
        /// and none was cut off: a pair is judged against the whole stem, and a
        /// second RAW past the cap or behind a failed page would be missed.</summary>
        public static bool IsCloudListingComplete(bool hitImageCap, bool pageFailed, bool cancelled, string? nextCursor) =>
            !hitImageCap && !pageFailed && !cancelled && string.IsNullOrEmpty(nextCursor);

        /// <summary>The cloud tiles that still need a thumbnail request: a
        /// file hidden behind a RAW at load is never requested, so it joins
        /// the next request once a format filter or switch makes it a tile.
        /// Each photo is handed out once per <paramref name="requested"/>
        /// set.</summary>
        public static List<PhotoItem> NeedingCloudThumbnails(IEnumerable<PhotoItem> tiles, ISet<PhotoItem> requested) =>
            tiles.Where(tile => tile.CloudAddress != null && tile.ThumbnailPath == null && requested.Add(tile)).ToList();

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
