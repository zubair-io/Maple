// TrashSelectionTypes.cs — shared vocabulary for Delete → Trash → Restore on
// the grid selection (#2654). Mirrors DragMoveTypes.cs's split: plain
// records so this pure logic can link into Maple.WinUI.Tests, which cannot
// reference WinUI/MVVM Toolkit types like PhotoItem.

using System;

namespace Maple.WinUI.Services.FileOperations
{
    /// <summary>One asset going into a Delete — the pure input
    /// TrashSelectionLogic needs. <paramref name="Key"/> is the caller's
    /// stable identifier (Windows uses the photo's pre-operation
    /// FilePath).</summary>
    public sealed record TrashSourceItem(
        string Key,
        string PrimaryPath,
        string FileName);

    /// <summary>Which destination a trash actually used (or, before the
    /// operation runs, is predicted to use — see
    /// <see cref="TrashSelectionLogic.PredictDestinationKind"/>). Distinct
    /// user-facing stories: Recycle Bin restores from File Explorer;
    /// MapleTrashFolder restores from the in-app "Restore from Maple
    /// Trash…" surface (MainWindow.TrashRestore.cs) — see the design doc's
    /// "Delete → Trash → Restore" asymmetry, which must stay visible in the
    /// UI rather than silently different.</summary>
    public enum TrashDestinationKind
    {
        RecycleBin,
        MapleTrashFolder,
    }

    public enum TrashOutcomeKind
    {
        Trashed,
        Error,
    }

    /// <summary>One item's outcome from a sequential Delete apply.
    /// <paramref name="DestinationKind"/> is set only for a
    /// <see cref="TrashOutcomeKind.Trashed"/> outcome — it is the ACTUAL
    /// destination used, which can differ from
    /// <see cref="TrashSelectionLogic.PredictDestinationKind"/>'s pre-flight
    /// guess when a local-fixed-drive Recycle Bin attempt itself
    /// fails.</summary>
    public sealed record TrashItemOutcome(
        string Key,
        string? FileName,
        TrashOutcomeKind Kind,
        TrashDestinationKind? DestinationKind = null,
        string? Error = null);

    /// <summary>One item's outcome from a sequential Restore-from-Maple-
    /// Trash apply (MainWindow.TrashRestore.cs).</summary>
    public sealed record RestoreItemOutcome(
        string Key,
        string? FileName,
        bool Ok,
        string? NewPath,
        string? Error);
}
