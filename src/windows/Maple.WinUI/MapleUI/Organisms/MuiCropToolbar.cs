using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Crop Toolbar organism (unified-component-catalog.md
    /// §4.5, "Crop Toolbar" row: "Aspect presets and straighten", built
    /// from Chip Row, Drag Bar, Button) — an aspect-ratio
    /// <see cref="MuiChipRow"/> (Original/1:1/4:5/16:9/Free by default),
    /// a straighten-angle <see cref="MuiDragBar"/>, and Rotate/Flip/Reset
    /// <see cref="MuiButton"/>s.
    ///
    /// MN2 (#3051) extensions, all defaulting to the original layout:
    /// <see cref="AspectPresets"/> swaps in a host-supplied preset list
    /// (the app ships nine ratios), <see cref="Orientation"/> stacks the
    /// rows vertically for narrow side-panel hosts (the chip row then
    /// scrolls horizontally, per MuiChipRow's own documented convention
    /// for hosts with more chips than fit), and
    /// <see cref="IsRotateVisible"/>/<see cref="IsFlipVisible"/> hide the
    /// action buttons a host has no behavior for.
    /// </summary>
    public sealed class MuiCropToolbar : ContentControl
    {
        private static readonly IReadOnlyList<MuiChip> DefaultAspectChips = new[]
        {
            new MuiChip("original", "Original"), new MuiChip("1:1", "1:1"),
            new MuiChip("4:5", "4:5"), new MuiChip("16:9", "16:9"), new MuiChip("free", "Free"),
        };

        public static readonly DependencyProperty SelectedAspectIdProperty =
            DependencyProperty.Register(nameof(SelectedAspectId), typeof(string), typeof(MuiCropToolbar),
                new PropertyMetadata("original", (d, e) => ((MuiCropToolbar)d)._aspectChips.SelectedId = (string)e.NewValue));

        public static readonly DependencyProperty StraightenAngleProperty =
            DependencyProperty.Register(nameof(StraightenAngle), typeof(double), typeof(MuiCropToolbar),
                new PropertyMetadata(0.0, (d, e) => ((MuiCropToolbar)d)._straighten.Value = (double)e.NewValue));

        public static readonly DependencyProperty AspectPresetsProperty =
            DependencyProperty.Register(nameof(AspectPresets), typeof(IReadOnlyList<MuiChip>), typeof(MuiCropToolbar),
                new PropertyMetadata(null, (d, _) => ((MuiCropToolbar)d).RebuildChips()));

        public static readonly DependencyProperty OrientationProperty =
            DependencyProperty.Register(nameof(Orientation), typeof(Orientation), typeof(MuiCropToolbar),
                new PropertyMetadata(Orientation.Horizontal, (d, _) => ((MuiCropToolbar)d).RebuildLayout()));

        public static readonly DependencyProperty IsRotateVisibleProperty =
            DependencyProperty.Register(nameof(IsRotateVisible), typeof(bool), typeof(MuiCropToolbar),
                new PropertyMetadata(true, (d, _) => ((MuiCropToolbar)d).RebuildLayout()));

        public static readonly DependencyProperty IsFlipVisibleProperty =
            DependencyProperty.Register(nameof(IsFlipVisible), typeof(bool), typeof(MuiCropToolbar),
                new PropertyMetadata(true, (d, _) => ((MuiCropToolbar)d).RebuildLayout()));

        public string SelectedAspectId { get => (string)GetValue(SelectedAspectIdProperty); set => SetValue(SelectedAspectIdProperty, value); }
        public double StraightenAngle { get => (double)GetValue(StraightenAngleProperty); set => SetValue(StraightenAngleProperty, value); }

        /// <summary>Host-supplied aspect chips. Null (default) keeps the
        /// catalog's Original/1:1/4:5/16:9/Free set.</summary>
        public IReadOnlyList<MuiChip>? AspectPresets
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(AspectPresetsProperty);
            set => SetValue(AspectPresetsProperty, value);
        }

        public Orientation Orientation { get => (Orientation)GetValue(OrientationProperty); set => SetValue(OrientationProperty, value); }
        public bool IsRotateVisible { get => (bool)GetValue(IsRotateVisibleProperty); set => SetValue(IsRotateVisibleProperty, value); }
        public bool IsFlipVisible { get => (bool)GetValue(IsFlipVisibleProperty); set => SetValue(IsFlipVisibleProperty, value); }

        public event EventHandler<string>? AspectSelected;
        public event EventHandler<double>? StraightenChanged;
        public event EventHandler? RotateRequested;
        public event EventHandler? FlipRequested;
        public event EventHandler? ResetRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 16 };
        private readonly ScrollViewer _chipScroll = new()
        {
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Enabled,
            VerticalScrollMode = ScrollMode.Disabled,
        };
        private readonly MuiChipRow _aspectChips = new() { Mode = MuiChipRowMode.Select, Chips = DefaultAspectChips };
        private readonly MuiDragBar _straighten = new() { Label = "Straighten", Minimum = -45, Maximum = 45, Step = 0.1 };
        private readonly StackPanel _buttonRow = new() { Orientation = Orientation.Horizontal, Spacing = 16 };
        private readonly MuiButton _rotate = new() { Variant = MuiButtonVariant.Ghost, IconName = "redo-uturn", Label = "Rotate" };
        private readonly MuiButton _flip = new() { Variant = MuiButtonVariant.Ghost, IconName = "split", Label = "Flip" };
        private readonly MuiButton _reset = new() { Variant = MuiButtonVariant.Ghost, IconName = "revert", Label = "Reset" };

        public MuiCropToolbar()
        {
            _chipScroll.Content = _aspectChips;
            _buttonRow.Children.Add(_rotate);
            _buttonRow.Children.Add(_flip);
            _buttonRow.Children.Add(_reset);
            _root.Children.Add(_chipScroll);
            _root.Children.Add(_straighten);
            _root.Children.Add(_buttonRow);
            Content = _root;

            _aspectChips.SelectionChanged += (_, id) => { SelectedAspectId = id; AspectSelected?.Invoke(this, id); };
            _straighten.ValueChanged += (_, angle) => { StraightenAngle = angle; StraightenChanged?.Invoke(this, angle); };
            _rotate.Click += (_, _) => RotateRequested?.Invoke(this, EventArgs.Empty);
            _flip.Click += (_, _) => FlipRequested?.Invoke(this, EventArgs.Empty);
            _reset.Click += (_, _) => ResetRequested?.Invoke(this, EventArgs.Empty);

            RebuildLayout();
        }

        private void RebuildChips()
        {
            _aspectChips.Chips = AspectPresets ?? DefaultAspectChips;
            _aspectChips.SelectedId = SelectedAspectId;
        }

        private void RebuildLayout()
        {
            _root.Orientation = Orientation;
            _root.Spacing = Orientation == Orientation.Vertical ? 10 : 16;
            _rotate.Visibility = IsRotateVisible ? Visibility.Visible : Visibility.Collapsed;
            _flip.Visibility = IsFlipVisible ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
