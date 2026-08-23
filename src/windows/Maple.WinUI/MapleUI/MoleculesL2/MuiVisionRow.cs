using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Vision Row molecule (unified-component-catalog.md §3,
    /// "Vision Row" row: "Classification result chips", built from Chip
    /// Row) — a thin, read-oriented wrapper: the underlying
    /// <see cref="MuiChipRow"/> still runs in Select mode (so a label can
    /// be focused/highlighted), but this molecule doesn't surface a
    /// two-way SelectedId — vision labels are model output, not a filter
    /// the caller needs to persist, matching
    /// `mui-vision-row.component.ts`'s own reasoning.
    /// </summary>
    public sealed class MuiVisionRow : ContentControl
    {
        public static readonly DependencyProperty LabelsProperty =
            DependencyProperty.Register(nameof(Labels), typeof(IReadOnlyList<MuiChip>), typeof(MuiVisionRow),
                new PropertyMetadata(null, (d, e) => ((MuiVisionRow)d)._chipRow.Chips = (IReadOnlyList<MuiChip>)e.NewValue));

        public IReadOnlyList<MuiChip>? Labels
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(LabelsProperty);
            set => SetValue(LabelsProperty, value);
        }

        private readonly MuiChipRow _chipRow = new() { Mode = MuiChipRowMode.Select };

        public MuiVisionRow()
        {
            Content = _chipRow;
            IsTabStop = false;
        }
    }
}
