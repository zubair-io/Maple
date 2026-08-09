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
                var outcome = await LocalFileOperations.TrashAsync(item.PrimaryPath, libraryRoot, recycleBin)
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
    }
}
