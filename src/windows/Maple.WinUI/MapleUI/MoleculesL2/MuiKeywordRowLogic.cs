using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free add/remove-list logic behind the Maple.UI Keyword
    /// Row molecule (unified-component-catalog.md §3, "Keyword Row" row).
    /// Same split as <see cref="MuiChipRowLogic"/>.
    ///
    /// `mui-keyword-row.component.ts` leaves the tag list itself
    /// host-owned (it only trims the draft and emits `added`/`removed` —
    /// see that file's own doc comment on why it composes Chip Row's
    /// Removable mode plus a second Input rather than Chip Row's own
    /// Editable mode), so there's no upstream `next-list` reducer to port.
    /// This wave's gallery specimen needs one anyway to be a genuinely
    /// live, stateful demo rather than a static snapshot — the same
    /// pure-list-transform shape a real host (e.g. an Enrichment Panel
    /// bound to XMP keywords) would apply to its own backing list in
    /// response to <c>MuiKeywordRow.Added</c>/<c>Removed</c>.
    /// </summary>
    public static class MuiKeywordRowLogic
    {
        /// <summary>Trims the trailing add-Input's draft; null (no chip
        /// added) for empty/whitespace-only, same rule as
        /// <see cref="MuiChipRowLogic.TrimDraft"/>.</summary>
        public static string? TrimDraft(string raw)
        {
            var trimmed = (raw ?? string.Empty).Trim();
            return trimmed.Length == 0 ? null : trimmed;
        }

        /// <summary>Appends a new chip (id == label — keywords have no
        /// separate identity) unless one with that id already exists.</summary>
        public static IReadOnlyList<MuiChip> Add(IReadOnlyList<MuiChip> chips, string trimmedLabel) =>
            chips.Any(chip => chip.Id == trimmedLabel)
                ? chips
                : chips.Append(new MuiChip(trimmedLabel, trimmedLabel)).ToList();

        public static IReadOnlyList<MuiChip> Remove(IReadOnlyList<MuiChip> chips, string id) =>
            chips.Where(chip => chip.Id != id).ToList();
    }
}
