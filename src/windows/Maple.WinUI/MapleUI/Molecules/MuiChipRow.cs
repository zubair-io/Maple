using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Chip Row molecule (unified-component-catalog.md §2.2, "Chip
    /// Row" row: "Row of pills — select, apply, or edit", built from Badge,
    /// Icon, Input) — a horizontal run of pills in one of three modes:
    /// Select (click to choose one), Removable (each pill carries a close
    /// button), or Editable (a trailing draft MuiInput appends new pills).
    ///
    /// Ports `mui-chip-row.component.ts` 1:1, including its exact selection
    /// (<see cref="MuiChipRowLogic.IsSelected"/>) and draft-trim
    /// (<see cref="MuiChipRowLogic.TrimDraft"/>) logic. Chips lay out in a
    /// single non-wrapping horizontal row — this wave has no compiler to
    /// verify an unfamiliar wrap-layout API against, so a host with more
    /// chips than fit horizontally is expected to place this inside a
    /// horizontally scrolling container, the same simplification
    /// `MuiGalleryWindow`'s own `Row()` helper already makes for atom
    /// specimens.
    /// </summary>
    public sealed class MuiChipRow : ContentControl
    {
        public static readonly DependencyProperty ChipsProperty =
            DependencyProperty.Register(nameof(Chips), typeof(IReadOnlyList<MuiChip>), typeof(MuiChipRow),
                new PropertyMetadata(null, (d, _) => ((MuiChipRow)d).Rebuild()));

        public static readonly DependencyProperty ModeProperty =
            DependencyProperty.Register(nameof(Mode), typeof(MuiChipRowMode), typeof(MuiChipRow),
                new PropertyMetadata(MuiChipRowMode.Select, (d, _) => ((MuiChipRow)d).Rebuild()));

        public static readonly DependencyProperty SelectedIdProperty =
            DependencyProperty.Register(nameof(SelectedId), typeof(string), typeof(MuiChipRow),
                new PropertyMetadata(null, (d, _) => ((MuiChipRow)d).Rebuild()));

        public static readonly DependencyProperty AddPlaceholderProperty =
            DependencyProperty.Register(nameof(AddPlaceholder), typeof(string), typeof(MuiChipRow),
                new PropertyMetadata("Add…", (d, _) => ((MuiChipRow)d).Rebuild()));

        public IReadOnlyList<MuiChip>? Chips
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(ChipsProperty);
            set => SetValue(ChipsProperty, value);
        }

        public MuiChipRowMode Mode
        {
            get => (MuiChipRowMode)GetValue(ModeProperty);
            set => SetValue(ModeProperty, value);
        }

        /// <summary>Select mode only.</summary>
        public string? SelectedId
        {
            get => (string?)GetValue(SelectedIdProperty);
            set => SetValue(SelectedIdProperty, value);
        }

        public string AddPlaceholder
        {
            get => (string)GetValue(AddPlaceholderProperty);
            set => SetValue(AddPlaceholderProperty, value);
        }

        /// <summary>Select mode: fires with the newly selected chip id.</summary>
        public event EventHandler<string>? SelectionChanged;

        /// <summary>Removable mode: fires with the removed chip's id — the
        /// host owns actually removing it from <see cref="Chips"/>.</summary>
        public event EventHandler<string>? Removed;

        /// <summary>Editable mode: fires with the trimmed new label — the
        /// host owns actually appending it to <see cref="Chips"/>.</summary>
        public event EventHandler<string>? Added;

        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiInput _draftInput = new() { Variant = MuiInputVariant.Default, InputSize = MuiInputSize.Sm };

        public MuiChipRow()
        {
            Content = _row;
            IsTabStop = false;
            _draftInput.Committed += (_, text) =>
            {
                var trimmed = MuiChipRowLogic.TrimDraft(text);
                if (trimmed is null) return;
                Added?.Invoke(this, trimmed);
                _draftInput.Text = string.Empty;
            };
            IsEnabledChanged += (_, _) => Rebuild();
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _row.Children.Clear();

            var chips = Chips ?? Array.Empty<MuiChip>();
            foreach (var chip in chips)
                _row.Children.Add(BuildChip(chip));

            if (Mode == MuiChipRowMode.Editable)
            {
                _draftInput.Placeholder = AddPlaceholder;
                _draftInput.Width = 120;
                _draftInput.IsEnabled = IsEnabled;
                _row.Children.Add(_draftInput);
            }

            Opacity = IsEnabled ? 1.0 : 0.45;

            AutomationProperties.SetName(this, $"{chips.Count} chips");
        }

        private UIElement BuildChip(MuiChip chip)
        {
            var selected = Mode == MuiChipRowMode.Select && MuiChipRowLogic.IsSelected(SelectedId, chip.Id);

            var pill = new Border
            {
                CornerRadius = new CornerRadius(999),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(10, 4, 10, 4),
                Background = selected ? R("MaplePrimaryDim") : R("MapleSurfaceAlt"),
                BorderBrush = selected ? R("MaplePrimary") : R("MapleBorder"),
            };

            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            content.Children.Add(new MuiText
            {
                Text = chip.Label,
                Variant = MuiTextVariant.ChipLabel,
                ColorRole = selected ? MuiTextColorRole.Main : MuiTextColorRole.Muted,
            });

            if (Mode == MuiChipRowMode.Removable)
            {
                var closeButton = new Button
                {
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(0),
                    MinWidth = 0,
                    MinHeight = 0,
                    IsEnabled = IsEnabled,
                    Content = new MuiIcon { IconName = "x", Size = MuiIconSize.Xs14 },
                };
                closeButton.Click += (_, _) => Removed?.Invoke(this, chip.Id);
                content.Children.Add(closeButton);
            }

            pill.Child = content;

            if (Mode == MuiChipRowMode.Select)
            {
                pill.Tapped += (_, _) =>
                {
                    if (!IsEnabled) return;
                    SelectedId = chip.Id;
                    SelectionChanged?.Invoke(this, chip.Id);
                };
            }

            return pill;
        }
    }
}
