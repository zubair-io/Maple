// The cldapi-free half of the FETCH_PLACEHOLDERS callback (#4757): a folder
// listing is either complete or failed, and only a complete one may tell
// Windows to stop asking (DISABLE_ON_DEMAND_POPULATION + success). A failed,
// signed-out or truncated listing completes with a failure status instead,
// so the folder stays unpopulated and Windows retries on the next open.

using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.CloudFiles
{
    internal sealed record PlaceholderEntry(string Name, string ServerPath, bool IsDirectory, long Size, DateTime MtimeUtc);

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

        internal static PlaceholderListing ListOrFail(Func<Task<PlaceholderListing>> list)
        {
            try
            {
                return list().GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] fetch-placeholders failed: {ex.Message}");
                return Failed;
            }
        }

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
