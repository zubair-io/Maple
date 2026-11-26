using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.ViewModels
{
    /// <summary>What a shell mode change asks of the saved-preview owner:
    /// signal the work still running (<see cref="Cancel"/>) and refresh every
    /// photo in <see cref="Release"/>.</summary>
    public sealed record SavedPreviewModeChange<T>(
        SavedPreviewDeferral<T> Next, bool Cancel, IReadOnlyList<T> Release) where T : class;

    /// <summary>
    /// Pure, WinUI-free rule for when the Browse/Preview derivative of a
    /// photo may be developed (#4374). In Edit the editor's own decode and
    /// Auto fit must not share the machine with a second develop of the same
    /// photo at another size, so a request there is not started: the photo is
    /// owed instead, and every owed photo is released when the shell returns
    /// to Preview or Browse. Generic over the photo type so it links into
    /// Maple.WinUI.Tests with a plain <c>string</c> stand-in.
    /// </summary>
    public sealed record SavedPreviewDeferral<T>(bool Editing, IReadOnlyList<T> Owed) where T : class
    {
        public static SavedPreviewDeferral<T> Idle { get; } = new(false, Array.Empty<T>());

        /// <summary>A refresh of <paramref name="photo"/>'s saved preview is
        /// wanted; <c>Start</c> says whether it may run now.</summary>
        public (SavedPreviewDeferral<T> Next, bool Start) Request(T photo) =>
            Editing ? (Owe(photo), false) : (this, true);

        /// <summary>A sidecar write was scheduled for <paramref name="photo"/>.
        /// Recorded at edit time, not save time: the debounced save can land
        /// after the selection has already moved to another photo.</summary>
        public SavedPreviewDeferral<T> Edited(T photo) => Editing ? Owe(photo) : this;

        /// <summary>The shell is now in <paramref name="mode"/>;
        /// <paramref name="inFlight"/> lists the photos whose refresh has
        /// started but not finished.</summary>
        public SavedPreviewModeChange<T> Enter(ShellMode mode, IReadOnlyList<T> inFlight)
        {
            var editing = mode == ShellMode.Edit;
            if (editing == Editing)
                return new SavedPreviewModeChange<T>(this, false, Array.Empty<T>());
            return editing
                ? new SavedPreviewModeChange<T>(
                    new SavedPreviewDeferral<T>(true, inFlight.Distinct().ToArray()), inFlight.Count > 0, Array.Empty<T>())
                : new SavedPreviewModeChange<T>(Idle, false, Owed);
        }

        private SavedPreviewDeferral<T> Owe(T photo) =>
            Owed.Contains(photo) ? this : this with { Owed = Owed.Append(photo).ToArray() };
    }
}
