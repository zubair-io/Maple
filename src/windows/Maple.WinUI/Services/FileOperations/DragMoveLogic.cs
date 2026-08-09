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

        /// <summary>Whether a drop event should be accepted/consumed —
        /// requires BOTH that the drag actually originated from this app's
        /// own PhotoGrid (<paramref name="isInternalDrag"/> — false for a
        /// drag dragged in from Windows Explorer or another app, which
        /// carries none of this app's private DataPackage marker) AND that
        /// the target has at least one applicable item to relocate
        /// (<paramref name="hasApplicableTarget"/>, from
        /// <see cref="HasApplicableItem"/>). Extracted as its own pure
        /// decision — rather than an inline `&amp;&amp;` at each of
        /// DragOver's and Drop's call sites — so the two independent guards
        /// can't silently be mis-ordered, dropped, or duplicated differently
        /// between the two handlers.</summary>
        public static bool ShouldAcceptDrop(bool isInternalDrag, bool hasApplicableTarget) =>
            isInternalDrag && hasApplicableTarget;

        /// <summary>True when a FOLDERS tree row is a legitimate drop
        /// target for an internal PhotoGrid drag at all — before any
        /// payload/self-drop analysis. False for a placeholder expander
        /// stub, an empty path, or (#2754) an unavailable library
        /// root (FolderNode.IsUnavailable, #2651): that row renders for a
        /// path that isn't reachable on disk right now, so accepting a
        /// drop there would relocate files against a directory that
        /// doesn't exist. Takes primitive flags rather than a FolderNode
        /// itself so this stays linkable into Maple.WinUI.Tests without
        /// pulling FolderNode's file in — see that test project's own
        /// header comment for why FolderNode isn't linkable there.</summary>
        public static bool IsEligibleDropTargetNode(bool isPlaceholder, bool isUnavailable, bool hasPath) =>
            !isPlaceholder && !isUnavailable && hasPath;

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
        /// no policy of its own — ApplyOneAsync filters a known, Skip-chosen
        /// collision out before ever calling RelocateAsync, so this mapping
        /// is only reached for items that must actually go through it; Fail
        /// is a defensive fallback that should never fire in practice (the
        /// one remaining case that reaches it with a Skip choice is a
        /// non-colliding item, which never triggers Fail regardless of
        /// policy).</summary>
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
        /// the pre-scan result from <see cref="DetectCollisions"/> — used
        /// ONLY to know which collisions the user was actually shown and
        /// asked about (see ApplyOneAsync's header comment for why applying
        /// their choice to a collision they never saw would be unsafe).
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
            // Tracks every NATURAL destination candidate (destinationDir +
            // an item's own CurrentFileName, unsuffixed) this batch has
            // already successfully relocated something onto — see
            // ApplyOneAsync's header comment for why this is the one
            // mechanism that closes BOTH the unflagged and the
            // pre-scan-flagged versions of the same data-loss shape.
            // OrdinalIgnoreCase: NTFS directory/file name comparison, same
            // comparer LocalFileOperations uses throughout this service.
            var claimedThisBatch = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var outcomes = new List<DragMoveItemOutcome>(items.Count);
            for (var i = 0; i < items.Count; i++)
            {
                outcomes.Add(await ApplyOneAsync(
                    items[i], destinationDir, mode, collidingKeys, collisionChoice, claimedThisBatch)
                    .ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        /// <summary>
        /// The pre-scan (<see cref="DetectCollisions"/>) runs once, before
        /// ANY item in the batch has moved, against whatever existed at
        /// <paramref name="destinationDir"/> BEFORE the drop started. Two
        /// different sequencing hazards can each let a batch-wide choice
        /// silently apply to a file the user never actually consented to
        /// touch:
        ///
        /// 1. UNFLAGGED: two same-basename items from different source
        ///    folders, neither colliding with the destination's pre-existing
        ///    contents at scan time (so neither lands in
        ///    <paramref name="collidingKeys"/>) — but the SECOND one
        ///    collides with the FIRST one's freshly-moved file the instant
        ///    the first relocate completes.
        /// 2. FLAGGED: the destination already has (say) IMG_001.dng, and
        ///    the batch ALSO carries two items both named IMG_001.dng — the
        ///    pre-scan flags BOTH of them as colliding with that one
        ///    pre-existing file, so both carry `knownCollision = true`. The
        ///    user's Replace choice was consent to overwrite the file that
        ///    existed before the drop — not consent for the second dragged
        ///    item to then overwrite the FIRST dragged item's result.
        ///
        /// Both hazards are the same shape once phrased correctly: consent
        /// for a given destination name is consumed the first time this
        /// batch successfully writes there. <paramref name="claimedThisBatch"/>
        /// tracks exactly that — the NATURAL (unsuffixed) candidate name
        /// each already-relocated item in this batch targeted. Any later
        /// item whose own natural candidate is already claimed gets forced
        /// onto <see cref="CollisionPolicy.AutoSuffix"/> — the one policy
        /// that can never lose data — regardless of what the user chose,
        /// and the outcome carries a <see cref="DragMoveItemOutcome.Note"/>
        /// so the override is visible rather than indistinguishable from an
        /// ordinary successful relocate.
        /// </summary>
        private static async Task<DragMoveItemOutcome> ApplyOneAsync(
            DragMoveSourceItem item,
            string destinationDir,
            RelocateMode mode,
            IReadOnlyCollection<string> collidingKeys,
            DragMoveCollisionChoice collisionChoice,
            HashSet<string> claimedThisBatch)
        {
            if (IsAlreadyInDestination(item, destinationDir))
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Skipped,
                    item.CurrentFileName, Error: "Already in this folder.");

            var candidatePath = Path.Combine(destinationDir, item.CurrentFileName);
            var claimedBySibling = claimedThisBatch.Contains(candidatePath);
            var collidesNow = !claimedBySibling
                && (File.Exists(candidatePath) || Directory.Exists(candidatePath));
            // OrdinalIgnoreCase: Key is a FilePath (Windows paths are
            // case-insensitive-but-case-preserving), matching how callers
            // treat the same keys elsewhere (e.g. EditSessionViewModel.
            // DragMove.cs's byKey dictionary).
            var knownCollision = collidesNow
                && collidingKeys.Contains(item.Key, StringComparer.OrdinalIgnoreCase);

            if (!claimedBySibling && knownCollision && collisionChoice == DragMoveCollisionChoice.Skip)
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Skipped,
                    item.CurrentFileName, Error: "Skipped — a file with this name already exists there.");

            // Claimed-by-a-sibling always overrides the chosen policy
            // (including Skip — the ORIGINAL pre-existing occupant this
            // item might also nominally collide with may already be gone,
            // replaced by that sibling, so "skip" has no well-defined
            // target left either). An unclaimed-but-live collision that
            // ISN'T one the pre-scan flagged is the same defensive
            // safety net as the claimed case — auto-suffix, never
            // destructive — for a collision this code has no record the
            // user was ever asked about.
            var forcedAutoSuffix = claimedBySibling || (collidesNow && !knownCollision);
            var policy = forcedAutoSuffix ? CollisionPolicy.AutoSuffix : ToCollisionPolicy(collisionChoice);

            try
            {
                var outcome = await LocalFileOperations
                    .RelocateAsync(item.CurrentPath, destinationDir, newBasename: null, mode, policy)
                    .ConfigureAwait(false);
                claimedThisBatch.Add(candidatePath);
                var note = forcedAutoSuffix && outcome.RenamedDueToCollision
                    ? "Renamed to avoid overwriting an item from this same drop."
                    : null;
                return new DragMoveItemOutcome(item.Key, DragMoveOutcomeKind.Relocated,
                    item.CurrentFileName, outcome.PrimaryPath, Note: note);
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
