using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Keyword Row molecule (unified-component-catalog.md §3,
    /// "Keyword Row" row: "Editable tag chips", built from Chip Row,
    /// Input) — Chip Row's <c>Mode</c> is a single-choice enum (Select/
    /// Removable/Editable), but keywords need both removal AND adding at
    /// once, so this composes Chip Row in Removable mode for the existing
    /// tags plus its own trailing add-<see cref="MuiInput"/>, matching
    /// `mui-keyword-row.component.ts`'s own reasoning for not just using
    /// Chip Row's Editable mode. The host owns the backing list — this
    /// control only trims the draft (<see cref="MuiKeywordRowLogic.TrimDraft"/>)
    /// and forwards <see cref="Added"/>/<see cref="Removed"/>.
    /// </summary>
    public sealed class MuiKeywordRow : ContentControl
    {
        public static readonly DependencyProperty KeywordsProperty =
            DependencyProperty.Register(nameof(Keywords), typeof(IReadOnlyList<MuiChip>), typeof(MuiKeywordRow),
                new PropertyMetadata(null, (d, _) => ((MuiKeywordRow)d).Rebuild()));

        public static readonly DependencyProperty AddPlaceholderProperty =
            DependencyProperty.Register(nameof(AddPlaceholder), typeof(string), typeof(MuiKeywordRow),
                new PropertyMetadata("+ add", (d, e) => ((MuiKeywordRow)d)._addInput.Placeholder = (string)e.NewValue));

        public IReadOnlyList<MuiChip>? Keywords
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(KeywordsProperty);
            set => SetValue(KeywordsProperty, value);
        }

        public string AddPlaceholder
        {
            get => (string)GetValue(AddPlaceholderProperty);
            set => SetValue(AddPlaceholderProperty, value);
        }

        public event EventHandler<string>? Removed;
        public event EventHandler<string>? Added;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiChipRow _chipRow = new() { Mode = MuiChipRowMode.Removable };
        private readonly MuiInput _addInput = new() { InputSize = MuiInputSize.Sm, Placeholder = "+ add", Width = 120 };

        public MuiKeywordRow()
        {
            _root.Children.Add(_chipRow);
            _root.Children.Add(_addInput);
            Content = _root;
            IsTabStop = false;

            _chipRow.Removed += (_, id) => Removed?.Invoke(this, id);
            _addInput.Committed += (_, raw) =>
            {
                var trimmed = MuiKeywordRowLogic.TrimDraft(raw);
                if (trimmed is null) return;
                Added?.Invoke(this, trimmed);
                _addInput.Text = string.Empty;
            };

            Rebuild();
        }

        private void Rebuild()
        {
            var keywords = Keywords ?? Array.Empty<MuiChip>();
            _chipRow.Chips = keywords;
            _chipRow.Visibility = keywords.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
