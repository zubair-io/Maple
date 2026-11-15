using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    public sealed partial class CloudFilesSyncRoot
    {
        private async Task RunChangeFeedAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var client = _client();
                    if (client is { IsAuthenticated: true })
                    {
                        var store = new CloudChangeCursorStore(client.ServerUrl, client.CurrentUserId);
                        var since = store.Read();
                        CloudChangePage? page;
                        try { page = await client.ListChangesAsync(since, 250, ct).ConfigureAwait(false); }
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
                            var applied = true;
                            var folders = actions.Count == 0 ? Array.Empty<CloudFolder>() :
                                await client.GetFoldersAsync(ct).ConfigureAwait(false) ?? Array.Empty<CloudFolder>();
                            foreach (var action in actions)
                                applied &= ApplyChangeAction(folders, action, ct);
                            var next = page.NextCursor ?? (page.Changes.Count == 0 ? since : page.Changes[^1].Cursor);
                            if (applied && next >= since) store.Write(next);
                        }
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex) { DiagLog.Write($"[cloudfiles] change-feed poll failed: {ex.Message}"); }
                try { await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            }
        }

        private bool ApplyChangeAction(
            IReadOnlyList<CloudFolder> folders, CloudChangeAction action, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            var folder = folders.FirstOrDefault(item => item.Id == action.FolderId);
            if (folder == null) return false;
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
                if (File.Exists(item) || Directory.Exists(item))
                {
                    if (CloudFilesPlaceholderProbe.IsInSyncPlaceholder(item))
                    {
                        if (!CloudFilesPlaceholderProbe.CanSafelyMutate(item)) return false;
                        var outcome = CloudFilesPlaceholderProbe.TryRemoveUnmodifiedPlaceholder(item);
                        if (outcome == RemovalOutcome.Failed) return false;
                        if (outcome == RemovalOutcome.NotEligible &&
                            (File.Exists(item) || Directory.Exists(item)) &&
                            CloudFilesPlaceholderProbe.IsInSyncPlaceholder(item)) return false;
                    }
                }
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
                    if (CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path))
                    {
                        if (!CloudFilesChangeApply.MetadataMatches(path, entry) &&
                            !CloudFilesChangeApply.UpdatePlaceholder(path, entry) &&
                            CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path))
                            return false;
                    }
                    byName.Remove(name);
                }
                else if (CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path))
                {
                    if (!CloudFilesPlaceholderProbe.CanSafelyMutate(path)) return false;
                    var outcome = CloudFilesPlaceholderProbe.TryRemoveUnmodifiedPlaceholder(path);
                    if (outcome == RemovalOutcome.Failed ||
                        (outcome == RemovalOutcome.NotEligible &&
                         CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path))) return false;
                }
            }
            toCreate = entries.Where(e => !existing.Contains(e.Name)).ToArray();
            return true;
        }
    }
}
