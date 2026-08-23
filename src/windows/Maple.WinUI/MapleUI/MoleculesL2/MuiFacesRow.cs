using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Faces Row molecule (unified-component-catalog.md §3,
    /// "Faces Row" row: "Count, person chips, re-detect", built from Chip
    /// Row, Button, Text) — a "N people" count, a select-mode
    /// <see cref="MuiChipRow"/> of detected people, and a Re-detect action.
    /// </summary>
    public sealed class MuiFacesRow : ContentControl
    {
        public static readonly DependencyProperty PeopleProperty =
            DependencyProperty.Register(nameof(People), typeof(IReadOnlyList<MuiChip>), typeof(MuiFacesRow),
                new PropertyMetadata(null, (d, _) => ((MuiFacesRow)d).Rebuild()));

        public static readonly DependencyProperty SelectedIdProperty =
            DependencyProperty.Register(nameof(SelectedId), typeof(string), typeof(MuiFacesRow),
                new PropertyMetadata(null, (d, e) => ((MuiFacesRow)d)._chipRow.SelectedId = (string)e.NewValue));

        public static readonly DependencyProperty RedetectingProperty =
            DependencyProperty.Register(nameof(Redetecting), typeof(bool), typeof(MuiFacesRow),
                new PropertyMetadata(false, (d, e) => ((MuiFacesRow)d)._redetectButton.IsLoading = (bool)e.NewValue));

        public IReadOnlyList<MuiChip>? People
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(PeopleProperty);
            set => SetValue(PeopleProperty, value);
        }

        public string? SelectedId
        {
            get => (string?)GetValue(SelectedIdProperty);
            set => SetValue(SelectedIdProperty, value);
        }

        public bool Redetecting
        {
            get => (bool)GetValue(RedetectingProperty);
            set => SetValue(RedetectingProperty, value);
        }

        public event EventHandler? Redetect;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 10 };
        private readonly MuiText _countText = new() { Variant = MuiTextVariant.ToolLabel, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiChipRow _chipRow = new() { Mode = MuiChipRowMode.Select };
        private readonly MuiButton _redetectButton = new()
        {
            Variant = MuiButtonVariant.Ghost,
            ButtonSize = MuiButtonSize.Sm,
            IconName = "history",
            Label = "Re-detect",
        };

        public MuiFacesRow()
        {
            _root.Children.Add(_countText);
            _root.Children.Add(_chipRow);
            _root.Children.Add(_redetectButton);
            Content = _root;
            IsTabStop = false;

            _chipRow.SelectionChanged += (_, id) => SelectedId = id;
            _redetectButton.Click += (_, _) => Redetect?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            var people = People ?? Array.Empty<MuiChip>();
            _countText.Text = people.Count == 1 ? "1 person" : $"{people.Count} people";
            _chipRow.Chips = people;
            _chipRow.Visibility = people.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
