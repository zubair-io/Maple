// EditSessionViewModel.RawJpegStack.cs — one tile for a same-stem RAW+JPEG
// pair in the Browse grid (#5050, #5848). Local folders always fold. A Maple
// Cloud folder is listed through GET /api/fs/dir, which never folds, so the
// same name rule (Services/FileOperations/RawJpegPairing.cs) is applied here
// when the server's display config allows it (CloudDisplayConfig). The cloud
// Timeline and search results are catalog rows and stay unfolded.

using System;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private bool _cloudFoldsRawJpegStacks;

        private bool FoldsRawJpegStacks =>
            _selectedLocalFolder != null || (_selectedCloudFolder != null && _cloudFoldsRawJpegStacks);

        /// <summary>False when the server cannot be asked: every file then
        /// keeps its own tile.</summary>
        private static async Task<bool> CloudFoldsRawJpegStacksAsync(CloudClient cloud, CancellationToken ct)
        {
            try
            {
                return (await cloud.GetDisplayConfigAsync(ct))?.FoldsRawJpegStacks == true;
            }
            catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or HttpRequestException)
            {
                return false;
            }
        }

        /// <summary>Re-points a tile, and the JPEG folded into it, after a
        /// rename or move put its files at new paths.</summary>
        private void ApplyStackRelocation(PhotoItem photo, string newPrimaryPath, string? newCompanionPath)
        {
            var companion = photo.StackCompanion;
            ApplyRenameOutcome(photo, newPrimaryPath);
            if (companion != null && newCompanionPath != null
                && !string.Equals(companion.FilePath, newCompanionPath, StringComparison.Ordinal))
                ApplyRenameOutcome(companion, newCompanionPath);
        }

        /// <summary>Recomputes the pairs after names changed in place, and
        /// rebuilds the grid only when a file gained or lost its tile.</summary>
        private void RefoldRawJpegStacks()
        {
            var foldedBefore = AllPhotos.Where(photo => photo.StackPrimary != null).ToHashSet();
            RawJpegStackFold.Apply(AllPhotos, FoldsRawJpegStacks);
            if (!foldedBefore.SetEquals(AllPhotos.Where(photo => photo.StackPrimary != null)))
                ApplyFilters();
        }

        private static async Task<CloudTrashOutcome> CloudTrashStackAsync(
            CloudClient cloud, PhotoItem raw, PhotoItem jpeg)
        {
            var rawAsset = await cloud.ResolveAssetAsync(raw.FilePath, CancellationToken.None).ConfigureAwait(false);
            var jpegAsset = await cloud.ResolveAssetAsync(jpeg.FilePath, CancellationToken.None).ConfigureAwait(false);
            if (rawAsset == null || jpegAsset == null
                || string.IsNullOrEmpty(rawAsset.Id) || string.IsNullOrEmpty(jpegAsset.Id))
                return new CloudTrashOutcome(raw, false,
                    "The server hasn't indexed both files of this RAW+JPEG pair yet — try again in a moment.");
            var result = await cloud.TrashStackAsync(rawAsset.Id, jpegAsset.Id, CancellationToken.None)
                .ConfigureAwait(false);
            return result switch
            {
                CloudStackTrashResult.Trashed => new CloudTrashOutcome(raw, true, null),
                CloudStackTrashResult.Missing => new CloudTrashOutcome(raw, false,
                    "One file of this RAW+JPEG pair is no longer on the server — reload the folder."),
                CloudStackTrashResult.AlreadyTrashed => new CloudTrashOutcome(raw, false,
                    "One file of this RAW+JPEG pair is already in the Trash — reload the folder."),
                _ => new CloudTrashOutcome(raw, false, "The server refused the delete — see maple.log."),
            };
        }
    }
}
