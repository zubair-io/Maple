namespace Maple.UI
{
    /// <summary>Chip Row interaction mode (unified-component-catalog.md
    /// §2.2, "Chip Row" row: "select, apply, or edit").</summary>
    public enum MuiChipRowMode { Select, Removable, Editable }

    /// <summary>One pill in a Chip Row.</summary>
    public readonly record struct MuiChip(string Id, string Label);

    /// <summary>
    /// Plain, WinUI-free selection/draft logic behind the Maple.UI Chip Row
    /// molecule (unified-component-catalog.md §2.2). Same split as
    /// <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests without
    /// a live Window.
    ///
    /// Ports the two bits of `mui-chip-row.component.ts` that carry real
    /// logic: `selectChip`'s equality check (Select mode) and
    /// `onDraftCommit`'s trim-and-reject-empty gate (Editable mode).
    /// </summary>
    public static class MuiChipRowLogic
    {
        /// <summary>True when <paramref name="chipId"/> is the row's
        /// current selection (Select mode) — null never matches any id.</summary>
        public static bool IsSelected(string? selectedId, string chipId) =>
            selectedId != null && selectedId == chipId;

        /// <summary>Trims the Editable mode's draft input and returns the
        /// trimmed text, or null when it's empty/whitespace-only — the
        /// signal to skip emitting an Added event and NOT clear the draft
        /// (matches `onDraftCommit`'s early return on an empty trim).</summary>
        public static string? TrimDraft(string raw)
        {
            var trimmed = raw.Trim();
            return trimmed.Length == 0 ? null : trimmed;
        }
    }
}
