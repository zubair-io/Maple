// The cldapi-free half of the FETCH_PLACEHOLDERS callback (#4757): a folder
// listing is either complete or failed, and only a complete one may tell
// Windows to stop asking (DISABLE_ON_DEMAND_POPULATION + success). A failed,
// signed-out or truncated listing completes with a failure status instead,
// so the folder stays unpopulated and Windows retries on the next open.
// Also maps a unified /api/folder/:slug/* page onto placeholder entries
// (#5852).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    internal sealed record PlaceholderEntry(string Name, string Identity, bool IsDirectory, long Size, DateTime MtimeUtc);

    internal sealed record PlaceholderPage(IReadOnlyList<PlaceholderEntry> Entries, string? NextCursor);

    internal readonly record struct PlaceholderListing(IReadOnlyList<PlaceholderEntry> Entries, bool Complete);

    internal readonly record struct PlaceholderCompletion(uint Flags, int Status);

    internal static class CloudFilesListing
    {
        internal static readonly PlaceholderListing Failed = new(Array.Empty<PlaceholderEntry>(), false);

        internal static PlaceholderListing Succeeded(IReadOnlyList<PlaceholderEntry> entries) => new(entries, true);

        internal static PlaceholderCompletion Completion(PlaceholderListing listing) =>
            listing.Complete
                ? new(CfApi.CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION, CfApi.STATUS_SUCCESS)
                : new(0, CfApi.STATUS_UNSUCCESSFUL);

        internal static PlaceholderEntry LibraryEntry(CloudFolder library) =>
            new(SanitizeName(library.DisplayName), CloudFilesIdentity.ForLibrary(library), true, 0, DateTime.UtcNow);

        /// <summary>Folders become directory placeholders; images, ordinary
        /// files and paired sidecars become file placeholders — the four
        /// kinds the Apple File Provider enumerates. A dot-named folder is
        /// skipped even though the server already hides its own: a `.maple`
        /// placeholder would invite Explorer into the trash/previews
        /// store.</summary>
        internal static PlaceholderPage FromFolderListing(CloudFolderListing listing)
        {
            var folders = listing.Folders
                .Where(folder => !folder.Name.StartsWith('.'))
                .Select(folder => Entry(folder, isDirectory: true));
            var files = listing.Images.Concat(listing.Files).Concat(listing.Sidecars)
                .Select(file => Entry(file, isDirectory: false));
            return new PlaceholderPage(folders.Concat(files).ToList(), listing.NextCursor);
        }

        private static PlaceholderEntry Entry(CloudFolderEntry entry, bool isDirectory) =>
            new(SanitizeName(entry.Name), CloudFilesIdentity.FromAddress(entry.Address), isDirectory,
                isDirectory ? 0 : entry.Size, ParseMtime(entry.Mtime));

        internal static DateTime ParseMtime(string? mtime) =>
            DateTime.TryParse(mtime, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var t)
                ? DateTime.SpecifyKind(t, DateTimeKind.Utc)
                : DateTime.UtcNow;

        internal static string SanitizeName(string name)
        {
            var invalid = InvalidNameChars;
            return name.Any(c => invalid.Contains(c))
                ? new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray())
                : name;
        }

        /// <summary>Windows' set, spelled out: Path.GetInvalidFileNameChars()
        /// is per-OS, and this runs on Windows but is pinned by tests on any
        /// host.</summary>
        private static readonly char[] InvalidNameChars =
            Enumerable.Range(0, 32).Select(c => (char)c).Concat("\"<>|:*?\\/").ToArray();

        internal static async Task<PlaceholderListing> PageAllAsync(Func<string?, Task<PlaceholderPage?>> fetchPage)
        {
            var entries = new List<PlaceholderEntry>();
            string? cursor = null;
            try
            {
                do
                {
                    var page = await fetchPage(cursor).ConfigureAwait(false);
                    if (page == null)
                        return Failed;
                    entries.AddRange(page.Entries);
                    cursor = page.NextCursor;
                } while (!string.IsNullOrEmpty(cursor));
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] listing failed: {ex.Message}");
                return Failed;
            }
            return Succeeded(entries);
        }
    }
}
