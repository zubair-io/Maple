// DragMoveLogic.cs — pure collision-detection + sequential-apply
// orchestration for dragging a PhotoGrid selection onto a sources-tree
// folder (#2648). See docs/superpowers/specs/2026-08-04-file-management-
// design.md § "Move / copy via drag-and-drop": drop targets are folder-tree
// nodes only, default drag = move, the platform copy-modifier = copy,
// multi-select drag carries the whole selection, collisions ASK
// (Skip / Replace / Keep Both) rather than silently picking a policy the
// way a background worker would.
//
// Mirrors BatchRenameLogic's shape (see that file's header comment) — a
// two-phase pure/impure split (DetectCollisions has no side effects of its
// own beyond the injected existence check; ApplySequentialAsync is the real
// LocalFileOperations.RelocateAsync orchestration, one item at a time, never
// rolled back on a later item's failure) — but a different collision
// resolution shape: batch-rename's collision policy is chosen once up front
// via a dialog combo, while drag-and-drop only asks AFTER discovering an
// actual collision, and the answer can mean "skip this item" (no
// CollisionPolicy equivalent), which is why this module carries its own
// DragMoveCollisionChoice rather than taking a bare CollisionPolicy.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static class DragMoveLogic
    {
        /// <summary>True when <paramref name="item"/> already lives directly
        /// in <paramref name="destinationDir"/> — the "dropped an asset onto
        /// the folder it's already in" no-op. Compared as plain directory
        /// strings (case-insensitive, trailing-separator-insensitive): this
        /// is a UI-level "don't bother" check, not the byte-for-byte
        /// same-file guard <see cref="LocalFileOperations.ClassifySameFile"/>
        /// already enforces one layer down (reparse points, case-only
        /// rename) — that guard still runs for real inside RelocateAsync;
        /// this one exists so the common case reports as a clean "Skipped",
        /// not a scary "Error: same file".</summary>
        public static bool IsAlreadyInDestination(DragMoveSourceItem item, string destinationDir) =>
            string.Equals(NormalizeDir(item.Directory), NormalizeDir(destinationDir), StringComparison.OrdinalIgnoreCase);

        /// <summary>True when at least one of <paramref name="items"/> would
        /// actually move/copy somewhere new — the gate a drop target checks
        /// BEFORE accepting a drop (design doc's "invalid targets rejected
        /// before drop"): a whole-selection self-drop (every dragged item
        /// already lives in the target folder) has nothing to do, so the
        /// target should refuse the drop outright rather than accept it and
        /// then report every single item "Skipped".</summary>
        public static bool HasApplicableItem(IReadOnlyList<DragMoveSourceItem> items, string destinationDir) =>
            items.Any(i => !IsAlreadyInDestination(i, destinationDir));

        /// <summary>Which of <paramref name="items"/> would collide with an
        /// existing file (or folder) at <paramref name="destinationDir"/> if
        /// relocated there unchanged — the pre-scan that decides whether the
        /// collision dialog needs to show at all. Items already sitting in
        /// the destination are excluded: <see cref="IsAlreadyInDestination"/>
        /// handles those as a separate "Skipped, not a collision" case, and
        /// counting them here would show a spurious collision dialog for a
        /// plain self-drop. <paramref name="pathExists"/> is injected (real
        /// callers pass <c>File.Exists(p) || Directory.Exists(p)</c>) so this
        /// stays testable without touching a real filesystem.</summary>
        public static IReadOnlyList<string> DetectCollisions(
            IReadOnlyList<DragMoveSourceItem> items,
            string destinationDir,
            Func<string, bool> pathExists)
        {
            var colliding = new List<string>();
            foreach (var item in items)
            {
                if (IsAlreadyInDestination(item, destinationDir))
                    continue;
                var candidate = Path.Combine(destinationDir, item.CurrentFileName);
                if (pathExists(candidate))
                    colliding.Add(item.Key);
            }
            return colliding;
        }

        /// <summary>Maps a user's collision choice onto the existing
        /// <see cref="CollisionPolicy"/> RelocateAsync understands. Skip has
        /// no policy of its own — ApplySequentialAsync filters skipped items
        /// out before ever calling RelocateAsync, so this mapping is only
        /// reached for items that must actually go through it; Fail is a
        /// defensive fallback that should never fire in practice (a Skip
        /// choice never reaches a colliding item, and a non-colliding item
        /// never collides regardless of policy).</summary>
        internal static CollisionPolicy ToCollisionPolicy(DragMoveCollisionChoice choice) => choice switch
        {
            DragMoveCollisionChoice.Replace => CollisionPolicy.Replace,
            DragMoveCollisionChoice.KeepBoth => CollisionPolicy.AutoSuffix,
            _ => CollisionPolicy.Fail,
        };

        /// <summary>Relocate every item, sequentially, awaiting each
        /// <see cref="LocalFileOperations.RelocateAsync"/> call before
        /// starting the next — same ordering contract as
        /// BatchRenameLogic.ApplySequentialAsync, for the same reason (a
        /// later item's collision check must see an earlier item's real
        /// on-disk result). One item's failure is recorded per-item and does
        /// NOT stop the remaining items. <paramref name="collidingKeys"/> is
        /// the pre-scan result from <see cref="DetectCollisions"/>;
        /// <paramref name="collisionChoice"/> is what the user picked when
        /// shown that dialog (irrelevant, and safe to pass any value, when
        /// <paramref name="collidingKeys"/> is empty — nothing collided, so
        /// nothing consults it). <paramref name="onItemDone"/>, if given, is
        /// invoked after each item completes with (items completed so far,
        /// total).</summary>
        public static async Task<IReadOnlyList<DragMoveItemOutcome>> ApplySequentialAsync(
            IReadOnlyList<DragMoveSourceItem> items,
            string destinationDir,
            RelocateMode mode,
            IReadOnlyCollection<string> collidingKeys,
            DragMoveCollisionChoice collisionChoice,
            Action<int, int>? onItemDone = null)
        {
            var policy = ToCollisionPolicy(collisionChoice);
            var outcomes = new List<DragMoveItemOutcome>(items.Count);
            for (var i = 0; i < items.Count; i++)
            {
                outcomes.Add(await ApplyOneAsync(items[i], destinationDir, mode, collidingKeys, collisionChoice, policy)
                    .ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        private static async Task<DragMoveItemOutcome> ApplyOneAsync(
            DragMoveSourceItem item,
            string destinationDir,
            RelocateMode mode,
            IReadOnlyCollection<string> collidingKeys,
            DragMoveCollisionChoice collisionChoice,
            CollisionPolicy policy)
        {
            if (IsAlreadyInDestination(item, destinationDir))
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Skipped,
                    item.CurrentFileName, Error: "Already in this folder.");

            if (collisionChoice == DragMoveCollisionChoice.Skip && collidingKeys.Contains(item.Key))
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Skipped,
                    item.CurrentFileName, Error: "Skipped — a file with this name already exists there.");

            try
            {
                var outcome = await LocalFileOperations
                    .RelocateAsync(item.CurrentPath, destinationDir, newBasename: null, mode, policy)
                    .ConfigureAwait(false);
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Relocated,
                    item.CurrentFileName, outcome.PrimaryPath);
            }
            catch (FileOperationException ex)
            {
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Error,
                    item.CurrentFileName, Error: ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Error,
                    item.CurrentFileName, Error: ex.Message);
            }
        }

        private static string NormalizeDir(string dir) =>
            dir.TrimEnd('\\', '/');
    }
}
