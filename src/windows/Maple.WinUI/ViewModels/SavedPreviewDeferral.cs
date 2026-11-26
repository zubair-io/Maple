using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.ViewModels
{
    public sealed record SavedPreviewModeChange(
        SavedPreviewDeferral Next, bool Cancel, IReadOnlyList<PhotoItem> Release);

    public enum SavedPreviewReleaseAction { RefreshThumbnail, Drop }

    public enum SavedPreviewRefreshOutcome { Refreshed, Failed, Cancelled }

    /// <summary>
    /// Pure, WinUI-free rule for when the saved Browse/Preview derivative of a
    /// photo may be developed (#4374). In Edit the editor's own decode and
    /// Auto fit must not share the machine with a second develop of the same
    /// photo at another size, so the develop is not started: the photo is owed
    /// instead, and every owed photo is released for refresh when the shell
    /// returns to Preview or Browse. A photo stays owed until a refresh of it
    /// is confirmed published (<see cref="Settle"/>).
    /// </summary>
    public sealed record SavedPreviewDeferral(bool Editing, IReadOnlyList<PhotoItem> Owed)
    {
        public static SavedPreviewDeferral Idle { get; } = new(false, Array.Empty<PhotoItem>());

        public (SavedPreviewDeferral Next, bool Start) Request(PhotoItem photo) =>
            Editing ? (Owe(photo), false) : (this, true);

        // Recorded at edit time, not save time: the debounced save can land after the selection has moved on.
        public SavedPreviewDeferral Edited(PhotoItem photo) => Editing ? Owe(photo) : this;

        public SavedPreviewModeChange Enter(ShellMode mode, IReadOnlyList<PhotoItem> inFlight)
        {
            var editing = mode == ShellMode.Edit;
            if (editing == Editing)
                return new SavedPreviewModeChange(this, false, Array.Empty<PhotoItem>());
            return editing
                ? new SavedPreviewModeChange(
                    new SavedPreviewDeferral(true, Owed.Concat(inFlight).Distinct().ToArray()),
                    inFlight.Count > 0, Array.Empty<PhotoItem>())
                : new SavedPreviewModeChange(this with { Editing = false }, false, Owed);
        }

        public SavedPreviewDeferral Settle(PhotoItem photo, SavedPreviewRefreshOutcome outcome) =>
            outcome == SavedPreviewRefreshOutcome.Refreshed
                ? this with { Owed = Owed.Where(owed => !ReferenceEquals(owed, photo)).ToArray() }
                : Owe(photo);

        public static bool MaySettle(object? rendered, object? latestAcknowledged) =>
            latestAcknowledged == null || ReferenceEquals(latestAcknowledged, rendered);

        public static SavedPreviewReleaseAction ClassifyUnselected(bool listed, bool cloud, bool cloudRefreshable) =>
            !listed || (cloud && !cloudRefreshable)
                ? SavedPreviewReleaseAction.Drop
                : SavedPreviewReleaseAction.RefreshThumbnail;

        private SavedPreviewDeferral Owe(PhotoItem photo) =>
            Owed.Contains(photo) ? this : this with { Owed = Owed.Append(photo).ToArray() };
    }
}
