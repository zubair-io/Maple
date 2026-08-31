// EditSessionViewModel.Trash.cs — Delete → Trash → Restore orchestration for
// the grid selection (#2654). Local fixed-drive deletes route through the
// OS Recycle Bin, restorable from Explorer; everything else (SMB, or a
// local delete where the Recycle Bin call itself failed) falls back to
// `.maple/trash/<rel>` and gets the minimal in-app restore surface built
// here (see MainWindow.Trash.cs / MainWindow.TrashRestore.cs).
//
// Deliberately does NOT re-point or remove the trashed PhotoItem from
// Photos/AllPhotos the way ApplyRenameOutcome does for a rename — a
// successful trash is a real filesystem delete from the browsed folder, and
// the existing LibraryWatcher (EditSessionViewModel.Library.cs's
// CreateLibraryWatcher) already reacts to that Deleted event and removes
// the PhotoItem on its own; duplicating that here would race the watcher's
// own removal. The same reasoning applies in reverse for Restore: a
// restored file lands back under a watched folder and the Created side of
// the same watcher picks it up.
//
// Cloud assets take a different route (#2741): the server owns their trash
// semantics — DELETE /api/assets/:id?intent=trash soft-deletes into the
// SERVER's .maple/trash and POST /api/assets/:id/restore brings the file
// back — so the cloud methods below are thin per-item API loops, not
// filesystem operations. Two deliberate asymmetries vs the local flow:
// (1) grid removal is explicit (RemoveCloudPhotos) because no
// LibraryWatcher watches the server's filesystem, and (2) restore listing
// comes from GET /api/folders/:id/trash instead of enumerating
// .maple/trash directories.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Local (non-cloud) photos in the selection — these route
        /// through the Recycle Bin / .maple-trash filesystem flow. Cloud
        /// photos route through <see cref="CloudTrashEligible"/> +
        /// <see cref="ApplyCloudTrashAsync"/> instead (#2741).</summary>
        public static IReadOnlyList<PhotoItem> TrashEligible(IReadOnlyList<PhotoItem> selection) =>
            selection.Where(p => !p.IsCloud).ToList();

        /// <summary>Cloud photos in the selection, deletable when a cloud
        /// session is connected (#2741).</summary>
        public static IReadOnlyList<PhotoItem> CloudTrashEligible(IReadOnlyList<PhotoItem> selection) =>
            selection.Where(p => p.IsCloud).ToList();

        /// <summary>Builds TrashSelectionLogic's pure source-item list from
        /// <paramref name="photos"/>, keyed by each photo's current
        /// FilePath.</summary>
        public static IReadOnlyList<TrashSourceItem> BuildTrashSources(IReadOnlyList<PhotoItem> photos) =>
            photos.Select(p => new TrashSourceItem(p.FilePath, p.FilePath, p.FileName)).ToList();

        /// <summary>Longest-matching open library root containing
        /// <paramref name="filePath"/>, or null if none does (shouldn't
        /// happen for a photo the grid is actually showing, but a photo can
        /// briefly outlive its root being removed via "Remove from
        /// Library" mid-session). Longest match wins so a root nested
        /// inside another open root resolves to the more specific
        /// one.</summary>
        public string? ResolveLibraryRootFor(string filePath)
        {
            var fileFull = Path.GetFullPath(filePath);
            string? best = null;
            foreach (var root in LibraryFolders)
            {
                var rootFull = TrashPaths.NormalizeDir(Path.GetFullPath(root));
                var isRoot = string.Equals(fileFull, rootFull, StringComparison.OrdinalIgnoreCase);
                var isUnder = fileFull.StartsWith(
                    rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
                if ((isRoot || isUnder) && (best == null || rootFull.Length > best.Length))
                    best = rootFull;
            }
            return best;
        }

        /// <summary>Applies Delete sequentially across
        /// <paramref name="sources"/>. No PhotoItem re-pointing happens
        /// here — see this file's header comment for why the
        /// LibraryWatcher already owns grid removal.</summary>
        public Task<IReadOnlyList<TrashItemOutcome>> ApplyTrashAsync(
            IReadOnlyList<TrashSourceItem> sources, Action<int, int>? onItemDone = null) =>
            // recycleBin passed positionally (not `recycleBin: null`) — a
            // named argument can't be followed by a positional one
            // (CS1738), and onItemDone here is positional.
            TrashSelectionLogic.ApplySequentialAsync(
                sources, item => ResolveLibraryRootFor(item.PrimaryPath), null, onItemDone);

        // --- Restore (.maple/trash only — Recycle Bin items restore via Explorer) ---

        /// <summary>Every item currently sitting in `.maple/trash` across
        /// every open library root. Off the UI thread (#2948):
        /// ListTrashItems does a RecurseSubdirectories enumerate plus a
        /// per-file stat across every library root, synchronously — a dead
        /// or sleeping SMB root stalls that walk for the OS timeout and
        /// would otherwise freeze the window from inside an `async void`
        /// handler with nothing to observe it. LibraryFolders is snapshotted
        /// on the calling (UI) thread first — it's an ObservableCollection
        /// the UI thread can mutate (add/remove a library folder) while this
        /// runs, and Task.Run's background enumeration must not race that.
        /// Mirrors InitializeLibrary's pattern (EditSessionViewModel.
        /// Library.cs).</summary>
        public Task<IReadOnlyList<TrashListItem>> ListMapleTrashAsync()
        {
            var roots = LibraryFolders.ToList();
            return Task.Run(() => MapleTrashListing.ListTrashItems(roots));
        }

        /// <summary>Restores every item in <paramref name="items"/>,
        /// sequentially, reporting per-item outcomes — the same
        /// don't-roll-back-the-rest-of-the-batch contract
        /// ApplyTrashAsync/ApplyBatchRenameAsync/ApplyDragMoveAsync all
        /// share.</summary>
        public async Task<IReadOnlyList<RestoreItemOutcome>> ApplyRestoreAsync(
            IReadOnlyList<TrashListItem> items, Action<int, int>? onItemDone = null)
        {
            var outcomes = new List<RestoreItemOutcome>(items.Count);
            for (var i = 0; i < items.Count; i++)
            {
                outcomes.Add(await RestoreOneAsync(items[i]).ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        private static async Task<RestoreItemOutcome> RestoreOneAsync(TrashListItem item)
        {
            try
            {
                var outcome = await LocalFileOperations
                    .RestoreFromMapleTrashAsync(item.TrashPrimaryPath, item.LibraryRoot)
                    .ConfigureAwait(false);
                return new RestoreItemOutcome(item.TrashPrimaryPath, item.FileName, true, outcome.PrimaryPath, null);
            }
            catch (FileOperationException ex)
            {
                return new RestoreItemOutcome(item.TrashPrimaryPath, item.FileName, false, null, ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new RestoreItemOutcome(item.TrashPrimaryPath, item.FileName, false, null, ex.Message);
            }
        }

        // --- Cloud trash / restore (#2741) — server-owned semantics ---

        /// <summary>Per-item outcome of a cloud trash batch — mirrors
        /// TrashItemOutcome's shape for the shared summary dialog.</summary>
        public sealed record CloudTrashOutcome(PhotoItem Photo, bool Ok, string? Error);

        /// <summary>One row of the cloud restore surface: a server trash
        /// item plus the library it belongs to.</summary>
        public sealed record CloudTrashEntry(string FolderId, string FolderName, Services.Cloud.CloudTrashItem Item)
        {
            /// <summary>ListView display line — same filename-first shape
            /// TrashListItem.DisplayLabel uses for local items, with the
            /// library and original folder for context.</summary>
            public string DisplayLabel =>
                $"{Item.Filename} — {FolderName}/{System.IO.Path.GetDirectoryName(Item.OriginalRelativePath)?.Replace('\\', '/')}".TrimEnd('/');
        }

        /// <summary>True when cloud items in the grid can be deleted — a
        /// signed-in cloud session exists.</summary>
        public bool CloudTrashAvailable => _cloud is { IsAuthenticated: true };

        /// <summary>Trashes <paramref name="items"/> on the server,
        /// sequentially: resolve each PhotoItem's server path to its asset
        /// id (GET /api/assets/by-fspath), then DELETE ?intent=trash. Same
        /// don't-roll-back-the-rest contract as ApplyTrashAsync. A file the
        /// indexer hasn't reached yet resolves to null and fails that item
        /// with an honest message instead of guessing.</summary>
        public async Task<IReadOnlyList<CloudTrashOutcome>> ApplyCloudTrashAsync(
            IReadOnlyList<PhotoItem> items, Action<int, int>? onItemDone = null)
        {
            var outcomes = new List<CloudTrashOutcome>(items.Count);
            for (var i = 0; i < items.Count; i++)
            {
                outcomes.Add(await CloudTrashOneAsync(items[i]).ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        private async Task<CloudTrashOutcome> CloudTrashOneAsync(PhotoItem photo)
        {
            if (_cloud is not { IsAuthenticated: true } cloud)
                return new CloudTrashOutcome(photo, false, "Not signed in to Maple Cloud.");
            try
            {
                var asset = await cloud.ResolveAssetAsync(photo.FilePath, CancellationToken.None)
                    .ConfigureAwait(false);
                // IsNullOrEmpty, not .Length: a server payload of {"id": null}
                // deserializes over the property initializer to a real null.
                if (asset == null || string.IsNullOrEmpty(asset.Id))
                    return new CloudTrashOutcome(photo, false,
                        "The server hasn't indexed this file yet — try again in a moment.");
                var ok = await cloud.TrashAssetAsync(asset.Id, CancellationToken.None).ConfigureAwait(false);
                return new CloudTrashOutcome(photo, ok, ok ? null : "The server refused the delete — see maple.log.");
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                // A dropped link or timeout fails THIS item and lets the rest
                // of the batch run — the same per-item resilience the local
                // TrashOneAsync/RestoreOneAsync equivalents have.
                return new CloudTrashOutcome(photo, false, $"Server unreachable: {ex.Message}");
            }
        }

        /// <summary>Removes successfully-trashed cloud photos from the grid.
        /// Explicit (unlike the local flow) because no LibraryWatcher
        /// observes the server's filesystem — without this the trashed item
        /// would linger until the next cloud folder reload. UI thread only
        /// (mutates AllPhotos and re-runs ApplyFilters).</summary>
        public void RemoveCloudPhotos(IReadOnlyList<PhotoItem> photos)
        {
            if (photos.Count == 0)
                return;
            var doomed = new HashSet<PhotoItem>(photos);
            AllPhotos.RemoveAll(doomed.Contains);
            ApplyFilters();
            Timeline.GroupPhotosByDate(AllPhotos);
        }

        /// <summary>Every restorable item in the server-side Trash across
        /// all cloud libraries, newest-first per library. Reaped rows
        /// (soft-deleted by the server's missing-file reaper — no trash
        /// copy exists) are filtered out: offering a restore that must fail
        /// is worse than not listing it. First page (500) per library —
        /// consistent with the dialog being a recovery surface, not a trash
        /// browser.</summary>
        public async Task<IReadOnlyList<CloudTrashEntry>> ListCloudTrashAsync()
        {
            if (_cloud is not { IsAuthenticated: true } cloud)
                return Array.Empty<CloudTrashEntry>();
            var folders = await cloud.GetFoldersAsync(CancellationToken.None).ConfigureAwait(false);
            if (folders == null)
                return Array.Empty<CloudTrashEntry>();
            var entries = new List<CloudTrashEntry>();
            foreach (var folder in folders)
            {
                var page = await cloud.ListTrashAsync(folder.Id, 500, null, CancellationToken.None)
                    .ConfigureAwait(false);
                if (page == null)
                    continue;
                entries.AddRange(page.Items
                    .Where(i => i.Reason != "reaped")
                    .Select(i => new CloudTrashEntry(folder.Id, folder.DisplayName, i)));
            }
            return entries;
        }

        /// <summary>Restores <paramref name="entries"/> on the server,
        /// sequentially, with the batch's shared per-item outcome
        /// contract.</summary>
        public async Task<IReadOnlyList<RestoreItemOutcome>> ApplyCloudRestoreAsync(
            IReadOnlyList<CloudTrashEntry> entries, Action<int, int>? onItemDone = null)
        {
            var outcomes = new List<RestoreItemOutcome>(entries.Count);
            for (var i = 0; i < entries.Count; i++)
            {
                var entry = entries[i];
                bool ok;
                string? error = null;
                try
                {
                    ok = _cloud is { IsAuthenticated: true } cloud
                        && await cloud.RestoreAssetAsync(entry.Item.AssetId, CancellationToken.None)
                            .ConfigureAwait(false);
                    if (!ok)
                        error = "The server refused the restore — see maple.log.";
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
                {
                    // Per-item network resilience — see CloudTrashOneAsync.
                    ok = false;
                    error = $"Server unreachable: {ex.Message}";
                }
                outcomes.Add(new RestoreItemOutcome(
                    entry.Item.TrashRelativePath, entry.Item.Filename, ok,
                    ok ? entry.Item.OriginalRelativePath : null, error));
                onItemDone?.Invoke(i + 1, entries.Count);
            }
            return outcomes;
        }
    }
}
