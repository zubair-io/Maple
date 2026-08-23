namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free "click text to edit, Enter/blur commits, Escape
    /// cancels" commit rule shared by every single-field inline editor in
    /// this library (<see cref="MuiInlineRenameField"/> at L1, plus L2's
    /// <c>MuiDescriptionField</c>/<c>MuiPlaceRow</c> — unified-component-
    /// catalog.md §§2.1, 3). Same split as <see cref="MuiChipRowLogic"/>:
    /// linkable into Maple.WinUI.Tests without a live Window.
    ///
    /// Ports the web library's shared <c>commitEditDraft</c> helper
    /// (internal/edit-in-place.ts) exactly: trims the draft, and — unless
    /// the trimmed value is unchanged from <paramref name="currentValue"/>
    /// (or, when <paramref name="allowEmpty"/> is false, empty — a rename
    /// or a place override may never commit blank; a description may) —
    /// returns the value to commit. Returns null when nothing should be
    /// emitted, which callers use as the exact same "stay as you were, no
    /// event" signal <c>commitEditDraft</c> gives its Angular callers.
    /// </summary>
    public static class MuiInlineEditLogic
    {
        public static string? ResolveCommit(string draft, string currentValue, bool allowEmpty)
        {
            var trimmed = (draft ?? string.Empty).Trim();
            if (trimmed == currentValue) return null;
            if (!allowEmpty && trimmed.Length == 0) return null;
            return trimmed;
        }
    }
}
