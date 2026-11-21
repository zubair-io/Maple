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
            var item = LocalItem(folder, action.RelativePath, out var listed);
            if (action.Kind == CloudChangeActionKind.DeleteIfInSync &&
                item != null && !TryRemoveStalePlaceholder(item)) return false;

            // The feed reports files, never the folders created around them, so
            // a change under a folder this PC has not seen refreshes the nearest
            // ancestor that exists. Siblings refresh too: a deleted RAW takes its
            // paired sidecar with it.
            if (listed == null)
            {
                // The library has no folder here yet, so the list of libraries is
                // what is stale. Best effort: a failure must not hold the cursor.
                CloudFilesChangeApply.EnableOnDemandPopulation(_syncRootPath);
                return true;
            }
            // Nothing populated yet: the first FETCH_PLACEHOLDERS reads the current server state.
            if (!CloudFilesPlaceholderProbe.IsPlaceholder(listed)) return true;
            return CloudFilesChangeApply.EnableOnDemandPopulation(listed);
        }

        /// <summary>Walks a server path down the local tree by placeholder
        /// identity, since a colliding or sanitized name differs from the
        /// server's. Returns the item when it exists and reports the deepest
        /// directory reached; a junction on the way ends the walk with neither.</summary>
        private string? LocalItem(CloudFolder folder, string relativePath, out string? deepestDirectory)
        {
            deepestDirectory = null;
            var current = LocalChild(_syncRootPath, folder.Slug + ":", SanitizeName(folder.DisplayName));
            var segments = relativePath.Split('/');
            for (var depth = 0; depth < segments.Length; depth++)
            {
                if (current == null || !Directory.Exists(current)) return null;
                if (new DirectoryInfo(current).LinkTarget != null)
                {
                    deepestDirectory = null;
                    return null;
                }
                deepestDirectory = current;
                current = LocalChild(
                    current, $"{folder.Slug}:{string.Join('/', segments.Take(depth + 1))}", SanitizeName(segments[depth]));
            }
            return current;
        }

        private static string? LocalChild(string directory, string address, string expectedName)
        {
            var expected = Path.Combine(directory, expectedName);
            if (File.Exists(expected) || Directory.Exists(expected))
            {
                var identity = CloudFilesPlaceholderProbe.ReadIdentity(expected);
                if (identity == null || identity == address || !CloudFilesAddress.IsAddress(identity)) return expected;
            }
            return Directory.EnumerateFileSystemEntries(directory)
                .FirstOrDefault(path => CloudFilesPlaceholderProbe.ReadIdentity(path) == address);
        }

        private async Task<bool> ReenablePopulatedDirectoriesAsync(CloudClient client, CancellationToken ct)
        {
            var folders = await client.GetFoldersAsync(ct).ConfigureAwait(false);
            if (folders == null) return false;
            // Best effort, so a library added meanwhile is listed too.
            CloudFilesChangeApply.EnableOnDemandPopulation(_syncRootPath);
            var succeeded = true;
            // Every directory under the root, since a library's local name can carry a collision suffix.
            foreach (var directory in EnumerateDirectoriesNoLinks(_syncRootPath).Skip(1))
            {
                ct.ThrowIfCancellationRequested();
                if (CloudFilesPlaceholderProbe.IsPlaceholder(directory))
                    succeeded &= CloudFilesChangeApply.EnableOnDemandPopulation(directory);
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
                // The sweep deletes an emptied root outright, pinned or not.
                if (CloudFilesPlaceholderProbe.IsPinned(path)) return true;
                if (CloudFilesPlaceholderProbe.TryRemoveUnpopulatedPlaceholderDirectory(path) == RemovalOutcome.Removed)
                    return true;
            }
            catch (IOException) { }
            CloudFilesSyncRootCleanup.Sweep(path, CloudFilesPlaceholderProbe.Probes);
            // What the sweep kept is the user's, unless it only kept a
            // placeholder because something had it open; that one is retried.
            return !Directory.Exists(path) || !HoldsBusyPlaceholder(path);
        }

        private static bool HoldsBusyPlaceholder(string directory)
        {
            try
            {
                return EnumerateDirectoriesNoLinks(directory)
                    .SelectMany(Directory.EnumerateFiles)
                    .Any(file => CloudFilesPlaceholderProbe.IsInSyncPlaceholder(file) &&
                        CloudFilesPlaceholderProbe.Mutability(file) == PlaceholderMutability.Busy);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return true; }
        }

        /// <summary>A re-enabled or half-transferred directory already
        /// holds placeholders, and TRANSFER_PLACEHOLDERS rejects names that
        /// exist. Null when the callback names no directory to compare with.</summary>
        private ListedDirectoryReconciler? ExistingPlaceholderReconciler(CfApi.CF_CALLBACK_INFO info)
        {
            if (info.NormalizedPath == IntPtr.Zero || info.VolumeDosName == IntPtr.Zero) return null;
            // NormalizedPath starts at the volume root and carries no drive.
            var directory = Marshal.PtrToStringUni(info.VolumeDosName) + Marshal.PtrToStringUni(info.NormalizedPath);
            return CloudFilesChangeApply.IsWithin(_syncRootPath, directory) ? new ListedDirectoryReconciler(directory) : null;
        }

        /// <summary>True when the existing item stays and covers the entry,
        /// false when it was removed and the entry needs a new placeholder
        /// (a file that became a folder, or the reverse), null when it cannot
        /// be reconciled yet.</summary>
        private static bool? ReconcileExisting(string path, PlaceholderEntry entry)
        {
            if (entry.IsDirectory != Directory.Exists(path) || HoldsAnotherAddress(path, entry))
                return TryRemoveStalePlaceholder(path) ? File.Exists(path) || Directory.Exists(path) : null;
            if (CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path) &&
                !CloudFilesChangeApply.MetadataMatches(path, entry) &&
                !TryRefreshPlaceholder(path, entry))
                return null;
            return true;
        }

        /// <summary>A name can pass from one server item to another when a
        /// case collision resolves. Identities from older builds are absolute
        /// paths and still resolve, so they are left alone.</summary>
        private static bool HoldsAnotherAddress(string path, PlaceholderEntry entry) =>
            CloudFilesPlaceholderProbe.ReadIdentity(path) is { } identity &&
            CloudFilesAddress.IsAddress(identity) && identity != entry.Address;

        private static bool TryRefreshPlaceholder(string path, PlaceholderEntry entry) =>
            CloudFilesPlaceholderProbe.Mutability(path) switch
            {
                PlaceholderMutability.Preserved => true,
                PlaceholderMutability.Busy => false,
                _ => CloudFilesChangeApply.UpdatePlaceholder(path, entry) ||
                    !CloudFilesPlaceholderProbe.IsInSyncPlaceholder(path),
            };

        /// <summary>Brings a directory's existing placeholders in line with
        /// a listing as its pages arrive. Anything that cannot be reconciled
        /// yet fails the listing, so Windows asks again.</summary>
        private sealed class ListedDirectoryReconciler
        {
            private readonly string _directory;
            private readonly HashSet<string> _listed = new(StringComparer.OrdinalIgnoreCase);
            private Dictionary<string, string>? _existing;

            internal ListedDirectoryReconciler(string directory) => _directory = directory;

            /// <summary>The page's entries that still need a placeholder, or
            /// null when an existing one could not be refreshed.</summary>
            internal IReadOnlyList<PlaceholderEntry>? MissingFrom(IReadOnlyList<PlaceholderEntry> page)
            {
                var existing = _existing ??= Existing();
                var missing = new List<PlaceholderEntry>(page.Count);
                foreach (var entry in page)
                {
                    _listed.Add(entry.Name);
                    if (!existing.TryGetValue(entry.Name, out var path))
                    {
                        missing.Add(entry);
                        continue;
                    }
                    var kept = ReconcileExisting(path, entry);
                    if (kept == null) return null;
                    if (kept == false)
                    {
                        existing.Remove(entry.Name);
                        missing.Add(entry);
                    }
                }
                return missing;
            }

            /// <summary>Removes in-sync placeholders the finished listing no
            /// longer names. Local, modified and pinned items stay.</summary>
            internal bool TryRemoveUnlisted()
            {
                try
                {
                    return (_existing ??= Existing())
                        .Where(item => !_listed.Contains(item.Key))
                        .All(item => TryRemoveStalePlaceholder(item.Value));
                }
                catch (Exception ex)
                {
                    DiagLog.Write($"[cloudfiles] placeholder reconcile failed: {ex.Message}");
                    return false;
                }
            }

            private Dictionary<string, string> Existing()
            {
                var existing = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (!Directory.Exists(_directory)) return existing;
                foreach (var path in Directory.EnumerateFileSystemEntries(_directory))
                    existing.TryAdd(Path.GetFileName(path), path);
                return existing;
            }
        }
    }
}
