// DragMoveTypes.cs — shared vocabulary for drag-assets-onto-the-sources-tree
// (#2648): decoupled input/output records for DragMoveLogic, mirroring
// BatchRenameTypes.cs's split (see that file's header comment for why —
// PhotoItem is a WinUI/MVVM Toolkit type and can't link into
// Maple.WinUI.Tests, so the pure logic here talks in plain records instead).
// The same code path serves BOTH entry points this ticket ships: the
// GridView-to-TreeView drag-and-drop gesture and the keyboard/Narrator-
// accessible "Move to Folder…" dialog (MainWindow.MoveToFolder.cs) — neither
// is a second implementation, both build these same records and call
// DragMoveLogic.ApplySequentialAsync.

using System;

namespace Maple.WinUI.Services.FileOperations
{
    /// <summary>One asset going into a drag-move/drag-copy — the pure input
    /// DragMoveLogic needs. <paramref name="Key"/> is the caller's stable
    /// identifier (Windows uses the photo's pre-operation FilePath) —
    /// carried through to <see cref="DragMoveItemOutcome"/> so the caller can
    /// map an outcome back to its PhotoItem.</summary>
    public sealed record DragMoveSourceItem(
        string Key,
        string Directory,
        string CurrentFileName,
        string CurrentPath);

    /// <summary>How a collision at the destination should be resolved — the
    /// three choices the design doc's drag-and-drop collision dialog offers
    /// (Skip / Replace / Keep Both), distinct from
    /// <see cref="CollisionPolicy"/>: "Skip" has no equivalent there (it
    /// means "don't call relocate for this item at all", handled by
    /// DragMoveLogic filtering the item out before any relocate call),
    /// while Replace/KeepBoth map directly onto the existing
    /// CollisionPolicy.Replace/AutoSuffix that LocalFileOperations already
    /// implements.</summary>
    public enum DragMoveCollisionChoice
    {
        Skip,
        Replace,
        KeepBoth,
    }

    public enum DragMoveOutcomeKind
    {
        /// <summary>Moved or copied successfully.</summary>
        Relocated,
        /// <summary>Never attempted — either the item was already in the
        /// destination folder (a no-op drop target), or the collision choice
        /// was Skip and this item collided.</summary>
        Skipped,
        /// <summary>The filesystem relocate itself failed (permissions, a
        /// vanished source, verification failure, …).</summary>
        Error,
    }

    /// <summary>One item's outcome from a sequential drag-move/drag-copy
    /// apply. <paramref name="Note"/> is set only when a
    /// <see cref="Kind"/> of <see cref="DragMoveOutcomeKind.Relocated"/>
    /// still deserves a caller-visible explanation — specifically, when
    /// DragMoveLogic overrode the user's chosen collision policy because
    /// this item's destination name was already claimed by an EARLIER item
    /// from the SAME batch rather than by whatever existed before the drop
    /// started (see DragMoveLogic.ApplyOneAsync's header comment). Without
    /// this, an auto-suffixed result would look identical to an ordinary
    /// successful relocate and the policy override would be silent.</summary>
    public sealed record DragMoveItemOutcome(
        string Key,
        DragMoveOutcomeKind Kind,
        string? FileName = null,
        string? NewPath = null,
        string? Error = null,
        string? Note = null);
}
