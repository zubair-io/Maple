// The stack rules behind EditSessionViewModel's undo history (#4764), free
// of any WinUI dependency so Maple.WinUI.Tests can drive them. Every path
// that records an entry — the quiet-timer boundary, Redo, Reset, Revert, a
// reloaded sidecar — goes through Push, so the depth cap and the redo wipe
// cannot drift apart again; Reset and Revert go through ReplaceModel, so a
// slider drag still inside its quiet window enters history before the
// replacement does, and a replacement that changes nothing records nothing.

using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public static class UndoHistoryLogic
    {
        public static bool SameEdit(AdjustmentState? a, AdjustmentState b) =>
            a != null && XmpWriter.Fingerprint(a) == XmpWriter.Fingerprint(b);

        /// <summary>Records <paramref name="entry"/> as the state Undo returns
        /// to next, drops the oldest entry past <paramref name="depth"/>, and
        /// invalidates Redo — a new edit forks history.</summary>
        public static void Push(
            List<AdjustmentState> undo, List<AdjustmentState> redo, AdjustmentState entry, int depth)
        {
            undo.Add(entry);
            if (undo.Count > depth)
                undo.RemoveAt(0);
            redo.Clear();
        }

        /// <summary>Closes the pending edit, if any, as its own entry: the
        /// baseline is what Undo must return to, the current model is what
        /// the user sees. Returns whether an entry was recorded.</summary>
        public static bool CommitBoundary(
            List<AdjustmentState> undo, List<AdjustmentState> redo,
            ref AdjustmentState? baseline, AdjustmentState current, int depth)
        {
            if (baseline == null || SameEdit(baseline, current))
                return false;
            Push(undo, redo, baseline, depth);
            baseline = current.Clone();
            return true;
        }

        /// <summary>Reset / Revert: a discrete replacement of the whole model.
        /// First the pending edit is committed (otherwise a drag still in
        /// its quiet window would vanish from history and Undo would land
        /// mid-drag), then the current model is recorded so the replacement
        /// itself is undoable. Returns false — and records nothing — when
        /// <paramref name="next"/> is already the current model.</summary>
        public static bool ReplaceModel(
            List<AdjustmentState> undo, List<AdjustmentState> redo,
            ref AdjustmentState? baseline, AdjustmentState current, AdjustmentState next, int depth)
        {
            CommitBoundary(undo, redo, ref baseline, current, depth);
            if (SameEdit(current, next))
                return false;
            Push(undo, redo, current.Clone(), depth);
            baseline = next.Clone();
            return true;
        }
    }
}
