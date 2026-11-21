using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    public sealed partial class CloudFilesSyncRoot
    {
        private const int ChangePageLimit = 250;

        private async Task RunChangeFeedAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                var backlogRemains = false;
                try
                {
                    var client = _client();
                    if (client is { IsAuthenticated: true })
                    {
                        var store = new CloudChangeCursorStore(client.ServerUrl, client.CurrentUserId);
                        var since = store.Read();
                        CloudChangePage? page;
                        try { page = await client.ListChangesAsync(since, ChangePageLimit, ct).ConfigureAwait(false); }
                        catch (CloudChangeCursorExpiredException ex)
                        {
                            if (!await ReenablePopulatedDirectoriesAsync(client, ct).ConfigureAwait(false))
                                throw new IOException("Could not re-enable populated directories after change cursor expiry.");
                            store.Write(ex.Current);
                            DiagLog.Write($"[cloudfiles] change cursor expired; resumed at {ex.Current} and re-enabled folder population");
                            page = null;
                        }

                        if (page != null)
                        {
                            var actions = CloudChangePlanner.Plan(page.Changes);
                            if (actions.Count != page.Changes.Count &&
                                !await ReenablePopulatedDirectoriesAsync(client, ct).ConfigureAwait(false))
                                throw new IOException("Could not re-enable folders for an incomplete change page.");
                            var folders = actions.Count == 0 ? Array.Empty<CloudFolder>() :
                                await client.GetFoldersAsync(ct).ConfigureAwait(false);
                            var applied = folders != null;
                            foreach (var action in actions)
                                applied = applied && ApplyChangeAction(folders!, action, ct);
                            var next = page.NextCursor ?? (page.Changes.Count == 0 ? since : page.Changes[^1].Cursor);
                            if (applied && next > since)
                            {
                                store.Write(next);
                                backlogRemains = page.Changes.Count >= ChangePageLimit;
                            }
                        }
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex) { DiagLog.Write($"[cloudfiles] change-feed poll failed: {ex.Message}"); }
                if (backlogRemains) continue;
                try { await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            }
        }

        private bool ApplyChangeAction(
            IReadOnlyList<CloudFolder> folders, CloudChangeAction action, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            var folder = folders.FirstOrDefault(item => item.Id == action.FolderId);
            // A library the server no longer lists has nothing left to refresh;
            // waiting on it would hold the cursor behind this row forever.
            if (folder == null) return true;
            var safeRoot = Path.Combine(SyncRootPath, SanitizeName(folder.DisplayName));
            var parentRelative = Path.GetDirectoryName(action.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            var parent = string.IsNullOrEmpty(parentRelative) ? safeRoot : Path.GetFullPath(Path.Combine(safeRoot, parentRelative));
            if (!CloudFilesChangeApply.IsWithin(safeRoot, parent)) return false;
            // An unopened directory has not been populated yet; its normal
            // first FETCH_PLACEHOLDERS will see the latest server snapshot.
            if (!Directory.Exists(parent)) return true;
            if (!CloudFilesPlaceholderProbe.IsPlaceholder(parent)) return true;

            if (action.Kind == CloudChangeActionKind.DeleteIfInSync)
            {
                var item = Path.GetFullPath(Path.Combine(safeRoot, action.RelativePath.Replace('/', Path.DirectorySeparatorChar)));
                if (!CloudFilesChangeApply.IsWithin(safeRoot, item)) return false;
                if ((File.Exists(item) || Directory.Exists(item)) && !TryRemoveStalePlaceholder(item)) return false;
                // Refresh siblings as well: a server-side RAW delete may have
                // a paired XMP entry that must disappear from the listing.
                return CloudFilesChangeApply.EnableOnDemandPopulation(parent);
            }
            return CloudFilesChangeApply.EnableOnDemandPopulation(parent);
        }

        private async Task<bool> ReenablePopulatedDirectoriesAsync(CloudClient client, CancellationToken ct)
        {
            var folders = await client.GetFoldersAsync(ct).ConfigureAwait(false);
            if (folders == null) return false;
            var succeeded = true;
            foreach (var folder in folders)
            {
                ct.ThrowIfCancellationRequested();
                var root = Path.Combine(SyncRootPath, SanitizeName(folder.DisplayName));
                if (!Directory.Exists(root)) continue;
                foreach (var directory in EnumerateDirectoriesNoLinks(root))
                {
                    ct.ThrowIfCancellationRequested();
                    if (CloudFilesPlaceholderProbe.IsPlaceholder(directory))
                        succeeded &= CloudFilesChangeApply.EnableOnDemandPopulation(directory);
                }
            }
            return succeeded;
        }

        private static IEnumerable<string> EnumerateDirectoriesNoLinks(string root)
        {
            var pending = new Stack<string>();
            pending.Push(root);
            while (pending.Count > 0)
            {
                var current = pending.Pop();
                yield return current;
                foreach (var child in Directory.EnumerateDirectories(current))
                    if (new DirectoryInfo(child).LinkTarget == null) pending.Push(child);
            }
        }

        /// <summary>False only when the item is still Maple's to remove and
        /// could not be removed yet. Pinned, modified and plain local items
        /// are kept and count as done.</summary>
        private static bool TryRemoveStalePlaceholder(string path)
        {
            if (!CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path)) return true;
            if (Directory.Exists(path)) return RemoveStaleDirectory(path);
            var mutability = CloudFilesPlaceholderProbe.Mutability(path);
            if (mutability != PlaceholderMutability.Mutable) return mutability == PlaceholderMutability.Preserved;
            try { return CloudFilesPlaceholderProbe.TryRemoveUnmodifiedPlaceholder(path) == RemovalOutcome.Removed; }
            catch (IOException) { return false; }
        }

        /// <summary>A populated directory cannot be deleted in one step, so
        /// it goes through the disable sweep: in-sync placeholders leave and
        /// the directory stays only while it still holds something kept.</summary>
        private static bool RemoveStaleDirectory(string path)
        {
            try
            {
                if (new DirectoryInfo(path).LinkTarget != null) return true;
                if (CloudFilesPlaceholderProbe.TryRemoveUnpopulatedPlaceholderDirectory(path) == RemovalOutcome.Removed)
                    return true;
            }
            catch (IOException) { }
            CloudFilesSyncRootCleanup.Sweep(path, CloudFilesPlaceholderProbe.Probes);
            return true;
        }

        /// <summary>A re-enabled directory already holds placeholders, and
        /// TRANSFER_PLACEHOLDERS rejects names that exist. Brings the existing
        /// ones in line with the listing and returns only the missing entries;
        /// anything that cannot be reconciled yet fails the listing so Windows
        /// asks again.</summary>
        private static PlaceholderListing ReconcileWithExistingPlaceholders(
            CfApi.CF_CALLBACK_INFO info, PlaceholderListing listing)
        {
            if (!listing.Complete || info.NormalizedPath == IntPtr.Zero || info.VolumeDosName == IntPtr.Zero)
                return listing;
            try
            {
                // NormalizedPath starts at the volume root and carries no drive.
                var directory = Marshal.PtrToStringUni(info.VolumeDosName) + Marshal.PtrToStringUni(info.NormalizedPath);
                if (!CloudFilesChangeApply.IsWithin(SyncRootPath, directory)) return listing;
                return TryReconcileListedDirectory(directory, listing.Entries, out var missing)
                    ? CloudFilesListing.Succeeded(missing)
                    : CloudFilesListing.Failed;
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] placeholder reconcile failed: {ex.Message}");
                return CloudFilesListing.Failed;
            }
        }

        private static bool TryRefreshPlaceholder(string path, PlaceholderEntry entry) =>
            CloudFilesPlaceholderProbe.Mutability(path) switch
            {
                PlaceholderMutability.Preserved => true,
                PlaceholderMutability.Busy => false,
                _ => CloudFilesChangeApply.UpdatePlaceholder(path, entry) ||
                    !CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path),
            };

        private static bool TryReconcileListedDirectory(
            string directory, IReadOnlyList<PlaceholderEntry> entries, out IReadOnlyList<PlaceholderEntry> toCreate)
        {
            toCreate = entries;
            if (!Directory.Exists(directory)) return true;
            var byName = new Dictionary<string, PlaceholderEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in entries) byName.TryAdd(entry.Name, entry);
            var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                var name = Path.GetFileName(path);
                existing.Add(name);
                if (byName.TryGetValue(name, out var entry))
                {
                    if (CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path) &&
                        !CloudFilesChangeApply.MetadataMatches(path, entry) &&
                        !TryRefreshPlaceholder(path, entry))
                        return false;
                    byName.Remove(name);
                }
                else if (!TryRemoveStalePlaceholder(path)) return false;
            }
            toCreate = entries.Where(e => !existing.Contains(e.Name)).ToArray();
            return true;
        }
    }
}
