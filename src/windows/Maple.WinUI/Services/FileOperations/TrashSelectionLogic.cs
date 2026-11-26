// TrashSelectionLogic.cs — pure sequential-apply orchestration for deleting
// a PhotoGrid selection (#2654). Mirrors DragMoveLogic.ApplySequentialAsync's
// shape (see that file's header comment): one item at a time, awaited before
// the next starts, one item's failure recorded per-item and never rolling
// back the rest of the batch — matches the design doc's "report per-file
// success/failure, don't roll back succeeded files on a later failure".
//
// Unlike DragMoveLogic there is no collision policy to thread through: a
// trash destination is always either the OS Recycle Bin (its own
// namespace, no collision with the library) or `.maple/trash/<rel>`, whose
// own auto-suffix collision handling already lives inside
// LocalFileOperations.Trash.cs — nothing here duplicates it.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static class TrashSelectionLogic
    {
        /// <summary>Best-effort PREDICTION of which destination
        /// <paramref name="primaryPath"/> will use, for confirmation-dialog
        /// copy shown BEFORE the operation runs (MainWindow.Trash.cs). The
        /// real per-item outcome (<see cref="TrashItemOutcome.DestinationKind"/>)
        /// can still differ if a predicted Recycle Bin attempt fails at the
        /// OS level and falls back to `.maple/trash` — this is only ever
        /// used to phrase the confirmation, never to skip or alter the
        /// actual <see cref="LocalFileOperations.TrashAsync"/> call.</summary>
        public static TrashDestinationKind PredictDestinationKind(string primaryPath) =>
            LocalFileOperations.IsOnLocalFixedDrive(primaryPath)
                ? TrashDestinationKind.RecycleBin
                : TrashDestinationKind.MapleTrashFolder;

        /// <summary>Trashes every item in <paramref name="items"/>,
        /// sequentially. <paramref name="resolveLibraryRoot"/> maps an item
        /// to the open library root it lives under (null if none does —
        /// reported as a per-item error rather than thrown, since a batch
        /// with one orphaned item should still trash the rest).
        /// <paramref name="onItemDone"/>, if given, is invoked after each
        /// item completes with (items completed so far, total).</summary>
        public static async Task<IReadOnlyList<TrashItemOutcome>> ApplySequentialAsync(
            IReadOnlyList<TrashSourceItem> items,
            Func<TrashSourceItem, string?> resolveLibraryRoot,
            IRecycleBinService? recycleBin,
            Action<int, int>? onItemDone = null)
        {
            var outcomes = new List<TrashItemOutcome>(items.Count);
            for (var i = 0; i < items.Count; i++)
            {
                outcomes.Add(await ApplyOneAsync(items[i], resolveLibraryRoot, recycleBin).ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        private static async Task<TrashItemOutcome> ApplyOneAsync(
            TrashSourceItem item,
            Func<TrashSourceItem, string?> resolveLibraryRoot,
            IRecycleBinService? recycleBin)
        {
            var libraryRoot = resolveLibraryRoot(item);
            if (libraryRoot == null)
            {
                return new TrashItemOutcome(item.Key, item.FileName, TrashOutcomeKind.Error,
                    Error: "No open library folder contains this photo.");
            }

            try
            {
                var outcome = await (item.CompanionPath == null
                    ? LocalFileOperations.TrashAsync(item.PrimaryPath, libraryRoot, recycleBin)
                    : LocalFileOperations.TrashStackAsync(
                        item.PrimaryPath, item.CompanionPath, libraryRoot, recycleBin))
                    .ConfigureAwait(false);
                // The Recycle Bin branch returns the ORIGINAL path
                // unchanged — see LocalFileOperations.Trash.cs's own doc
                // comment ("PrimaryPath here means the original path, now
                // recoverable via the OS Recycle Bin, not a literal current
                // location"). The `.maple/trash` fallback always relocates
                // to a different path. Comparing against the exact literal
                // passed in — rather than a second
                // IsOnLocalFixedDrive/TrySendToRecycleBin call — avoids a
                // duplicate (and potentially double-executed) shell call
                // just to learn which branch ran.
                var destination = string.Equals(outcome.PrimaryPath, item.PrimaryPath, StringComparison.Ordinal)
                    ? TrashDestinationKind.RecycleBin
                    : TrashDestinationKind.MapleTrashFolder;

                if (destination == TrashDestinationKind.MapleTrashFolder)
                {
                    // Record the TRUE original relative path now, while this
                    // is still the one place that knows it — a trash-side
                    // collision auto-suffixes outcome.PrimaryPath's basename
                    // (LocalFileOperations.Trash.cs's
                    // TrashToMapleFolderAsync), so inferring the original
                    // name later from that suffixed trash-side path alone
                    // would be wrong. See
                    // LocalFileOperations.TrashRestore.cs's header (#2743
                    // review fix) for the full story.
                    var originalRelativePath = Path.GetRelativePath(libraryRoot, item.PrimaryPath);
                    LocalFileOperations.TryWriteOriginalPathMarker(outcome.PrimaryPath, originalRelativePath);
                    if (item.CompanionPath != null && outcome.CompanionPath != null)
                        LocalFileOperations.TryWriteOriginalPathMarker(
                            outcome.CompanionPath, Path.GetRelativePath(libraryRoot, item.CompanionPath));
                }

                return new TrashItemOutcome(item.Key, item.FileName, TrashOutcomeKind.Trashed, destination);
            }
            catch (FileOperationException ex)
            {
                return new TrashItemOutcome(item.Key, item.FileName, TrashOutcomeKind.Error, Error: ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new TrashItemOutcome(item.Key, item.FileName, TrashOutcomeKind.Error, Error: ex.Message);
            }
        }

        public static async Task<IReadOnlyList<RestoreItemOutcome>> ApplyRestoreSequentialAsync(
            IReadOnlyList<TrashListItem> items, Action<int, int>? onItemDone = null)
        {
            var outcomes = new List<RestoreItemOutcome>(items.Count);
            var restoredWithTheirPair = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var selectedPaths = items.Select(item => item.TrashPrimaryPath).ToHashSet(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < items.Count; i++)
            {
                var item = items[i];
                outcomes.Add(restoredWithTheirPair.TryGetValue(item.TrashPrimaryPath, out var restoredPath)
                    ? new RestoreItemOutcome(item.TrashPrimaryPath, item.FileName, true, restoredPath, null)
                    : await RestoreOneAsync(item, restoredWithTheirPair, selectedPaths).ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        // Restoring one half of a trashed RAW+JPEG pair brings the other back
        // with it, so a selection naming both halves restores them once, and
        // a selection naming one half reports the other as part of the result.
        private static async Task<RestoreItemOutcome> RestoreOneAsync(
            TrashListItem item, Dictionary<string, string> restoredWithTheirPair, HashSet<string> selectedPaths)
        {
            try
            {
                var companionTrashPath = LocalFileOperations.TrashedCompanionOf(item.TrashPrimaryPath, item.LibraryRoot);
                var outcome = await LocalFileOperations
                    .RestoreFromMapleTrashAsync(item.TrashPrimaryPath, item.LibraryRoot)
                    .ConfigureAwait(false);
                if (companionTrashPath != null && outcome.CompanionPath != null)
                    restoredWithTheirPair[companionTrashPath] = outcome.CompanionPath;
                var unselectedCompanion = companionTrashPath != null && !selectedPaths.Contains(companionTrashPath)
                    ? outcome.CompanionPath
                    : null;
                return new RestoreItemOutcome(
                    item.TrashPrimaryPath, item.FileName, true, outcome.PrimaryPath, null, unselectedCompanion);
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

        public static string DescribeRestore(IReadOnlyList<RestoreItemOutcome> outcomes)
        {
            var pairs = outcomes.Where(outcome => outcome.Ok && outcome.CompanionNewPath != null).ToList();
            var restored = outcomes.Count(outcome => outcome.Ok) + pairs.Count;
            var failed = outcomes.Count(outcome => !outcome.Ok);
            if (failed > 0)
                return $"Restored {restored} of {restored + failed} photos. {failed} failed.";
            if (pairs.Count == 0)
                return $"Restored {restored} photo{(restored == 1 ? "" : "s")}.";
            var named = pairs.Select(outcome =>
                $"{Path.GetFileName(outcome.NewPath)} and {Path.GetFileName(outcome.CompanionNewPath)}");
            return outcomes.Count == 1
                ? $"Restored {named.Single()}."
                : $"Restored {restored} photos, including {string.Join("; ", named)}.";
        }
    }
}
