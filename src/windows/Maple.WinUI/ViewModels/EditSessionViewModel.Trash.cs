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
// Cloud assets are explicitly out of scope here — same restriction as
// rename/batch-rename/drag-move (EditSessionViewModel.Rename.cs,
// .BatchRename.cs, .DragMove.cs). Unlike those, Cloud has no delete path
// reachable from the Windows grid AT ALL today — CloudClient.cs has no
// delete/trash/restore call — tracked as its own gap by #2741 rather than
// silently ignored.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Local (non-cloud) photos eligible for Delete — same
        /// restriction every other local file-operations entry point in
        /// this class uses. See #2741 for the tracked Cloud gap.</summary>
        public static IReadOnlyList<PhotoItem> TrashEligible(IReadOnlyList<PhotoItem> selection) =>
            selection.Where(p => !p.IsCloud).ToList();

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
            TrashSelectionLogic.ApplySequentialAsync(
                sources, item => ResolveLibraryRootFor(item.PrimaryPath), recycleBin: null, onItemDone);

        // --- Restore (.maple/trash only — Recycle Bin items restore via Explorer) ---

        /// <summary>Every item currently sitting in `.maple/trash` across
        /// every open library root.</summary>
        public IReadOnlyList<TrashListItem> ListMapleTrash() =>
            MapleTrashListing.ListTrashItems(LibraryFolders);

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
    }
}
