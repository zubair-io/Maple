// The cldapi-free half of the FETCH_PLACEHOLDERS callback (#4757): a folder
// listing is either complete or failed, and only a complete one may tell
// Windows to stop asking (DISABLE_ON_DEMAND_POPULATION + success). A failed,
// signed-out or truncated listing completes with a failure status instead,
// so the folder stays unpopulated and Windows retries on the next open.

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.CloudFiles
{
internal sealed record PlaceholderEntry(string Name, string Address, bool IsDirectory, long Size, DateTime MtimeUtc);

    internal sealed record PlaceholderPage(IReadOnlyList<PlaceholderEntry> Entries, string? NextCursor);

    internal readonly record struct PlaceholderListing(IReadOnlyList<PlaceholderEntry> Entries, bool Complete);

    internal readonly record struct PlaceholderCompletion(uint Flags, int Status);

    internal readonly record struct PlaceholderStreamResult(bool Complete, int TransferredCount);

    internal static class CloudFilesListing
    {
        internal static readonly PlaceholderListing Failed = new(Array.Empty<PlaceholderEntry>(), false);

        /// <summary>Make provider names representable in a case-insensitive
        /// Windows directory without changing the server address used as
        /// FileIdentity. The stable identity suffix keeps collisions visible
        /// and repeatable across paged fetches.</summary>
        internal static IReadOnlyList<PlaceholderEntry> WithUniqueWindowsNames(
            IReadOnlyList<PlaceholderEntry> entries, HashSet<string> names)
        {
            var result = new List<PlaceholderEntry>(entries.Count);
            foreach (var entry in entries)
            {
                var name = entry.Name;
                if (names.Add(name))
                {
                    result.Add(entry);
                    continue;
                }

                DiagLog.Write($"[cloudfiles] disambiguating case-insensitive placeholder name collision: {name}");

                var extension = Path.GetExtension(name);
                var stem = extension.Length == 0 ? name : name[..^extension.Length];
                var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(entry.Address)));
                string? candidate = null;
                for (var suffixLength = 8; suffixLength <= hash.Length; suffixLength += 4)
                {
                    var possible = $"{stem} ({hash[..suffixLength]}){extension}";
                    if (names.Add(possible))
                    {
                        candidate = possible;
                        break;
                    }
                }
                if (candidate == null)
                    throw new InvalidOperationException("Cloud Files name collision could not be disambiguated.");
                result.Add(entry with { Name = candidate });
            }
            return result;
        }

        internal static PlaceholderListing Succeeded(IReadOnlyList<PlaceholderEntry> entries) => new(entries, true);

        internal static PlaceholderCompletion Completion(PlaceholderListing listing) =>
            listing.Complete
                ? new(CfApi.CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION, CfApi.STATUS_SUCCESS)
                : new(0, CfApi.STATUS_UNSUCCESSFUL);

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

        /// <summary>Fetch and transfer each server page immediately. Each
        /// accepted CfExecute transfer resets pending Cloud Files callback
        /// timers; only the last page disables further population. A failed
        /// later page remains retryable because no completion flag was sent.</summary>
        internal static async Task<PlaceholderStreamResult> StreamPagesAsync(
            Func<string?, Task<PlaceholderPage?>> fetchPage,
            Func<IReadOnlyList<PlaceholderEntry>, int, bool> transferPage)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string? cursor = null;
            var totalCount = 0;
            var transferredCount = 0;
            try
            {
                do
                {
                    var page = await fetchPage(cursor).ConfigureAwait(false);
                    if (page == null)
                        return new(false, transferredCount);

                    var entries = WithUniqueWindowsNames(page.Entries, names);
                    totalCount += entries.Count;
                    if (!transferPage(entries, totalCount))
                        return new(false, transferredCount);
                    transferredCount += entries.Count;
                    cursor = page.NextCursor;
                } while (!string.IsNullOrEmpty(cursor));

                return new(true, transferredCount);
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] listing failed: {ex.Message}");
                return new(false, transferredCount);
            }
        }
    }
}
