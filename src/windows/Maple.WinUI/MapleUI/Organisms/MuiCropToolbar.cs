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
    /// <see cref="MuiChipRow"/> (Original/1:1/4:5/16:9/Free), a
    /// straighten-angle <see cref="MuiDragBar"/>, and Rotate/Flip/Reset
    /// <see cref="MuiButton"/>s.
    /// </summary>
    public sealed class MuiCropToolbar : ContentControl
    {
        private static readonly IReadOnlyList<MuiChip> AspectChips = new[]
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

        public string SelectedAspectId { get => (string)GetValue(SelectedAspectIdProperty); set => SetValue(SelectedAspectIdProperty, value); }
        public double StraightenAngle { get => (double)GetValue(StraightenAngleProperty); set => SetValue(StraightenAngleProperty, value); }

        public event EventHandler<string>? AspectSelected;
        public event EventHandler<double>? StraightenChanged;
        public event EventHandler? RotateRequested;
        public event EventHandler? FlipRequested;
        public event EventHandler? ResetRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 16 };
        private readonly MuiChipRow _aspectChips = new() { Mode = MuiChipRowMode.Select, Chips = AspectChips };
        private readonly MuiDragBar _straighten = new() { Label = "Straighten", Minimum = -45, Maximum = 45, Step = 0.1 };
        private readonly MuiButton _rotate = new() { Variant = MuiButtonVariant.Ghost, IconName = "redo-uturn", Label = "Rotate" };
        private readonly MuiButton _flip = new() { Variant = MuiButtonVariant.Ghost, IconName = "split", Label = "Flip" };
        private readonly MuiButton _reset = new() { Variant = MuiButtonVariant.Ghost, IconName = "revert", Label = "Reset" };

        public MuiCropToolbar()
        {
            _root.Children.Add(_aspectChips);
            _root.Children.Add(_straighten);
            _root.Children.Add(_rotate);
            _root.Children.Add(_flip);
            _root.Children.Add(_reset);
            Content = _root;

            _aspectChips.SelectionChanged += (_, id) => { SelectedAspectId = id; AspectSelected?.Invoke(this, id); };
            _straighten.ValueChanged += (_, angle) => { StraightenAngle = angle; StraightenChanged?.Invoke(this, angle); };
            _rotate.Click += (_, _) => RotateRequested?.Invoke(this, EventArgs.Empty);
            _flip.Click += (_, _) => FlipRequested?.Invoke(this, EventArgs.Empty);
            _reset.Click += (_, _) => ResetRequested?.Invoke(this, EventArgs.Empty);
        }
    }
}
