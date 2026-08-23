using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One source frame in a Panorama Merge run.</summary>
    public sealed record MuiPanoramaFrame(string Id, ImageSource? Source, string Filename);

    /// <summary>
    /// Maple.UI Panorama Merge modal organism (unified-component-catalog.md
    /// §4.4, "Panorama Merge" row: "Stitch options and progress", built
    /// from Form Field, Progress, Media Cell) — a row of source-frame
    /// <see cref="MuiMediaCell"/>s, a projection <see cref="MuiFormField"/>,
    /// and a determinate <see cref="MuiProgress"/> while stitching.
    /// </summary>
    public sealed class MuiPanoramaMergeModal : ContentControl
    {
        private static readonly IReadOnlyList<MuiSegmentedToggleOption> Projections = new[]
        {
            new MuiSegmentedToggleOption("Cylindrical"), new MuiSegmentedToggleOption("Spherical"), new MuiSegmentedToggleOption("Planar"),
        };

        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiPanoramaMergeModal),
                new PropertyMetadata(false, (d, e) => ((MuiPanoramaMergeModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiPanoramaMergeModal),
                new PropertyMetadata(false, (d, e) => ((MuiPanoramaMergeModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty FramesProperty =
            DependencyProperty.Register(nameof(Frames), typeof(IReadOnlyList<MuiPanoramaFrame>), typeof(MuiPanoramaMergeModal),
                new PropertyMetadata(null, (d, _) => ((MuiPanoramaMergeModal)d).Rebuild()));

        public static readonly DependencyProperty IsStitchingProperty =
            DependencyProperty.Register(nameof(IsStitching), typeof(bool), typeof(MuiPanoramaMergeModal),
                new PropertyMetadata(false, (d, _) => ((MuiPanoramaMergeModal)d).Rebuild()));

        public static readonly DependencyProperty StitchProgressProperty =
            DependencyProperty.Register(nameof(StitchProgress), typeof(double), typeof(MuiPanoramaMergeModal),
                new PropertyMetadata(0.0, (d, e) => ((MuiPanoramaMergeModal)d)._progress.Value = (double)e.NewValue));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiPanoramaFrame>? Frames
        {
            get => (IReadOnlyList<MuiPanoramaFrame>?)GetValue(FramesProperty);
            set => SetValue(FramesProperty, value);
        }

        public bool IsStitching { get => (bool)GetValue(IsStitchingProperty); set => SetValue(IsStitchingProperty, value); }
        public double StitchProgress { get => (double)GetValue(StitchProgressProperty); set => SetValue(StitchProgressProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? StitchRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Lg, AriaLabel = "Panorama Merge" };
        private readonly StackPanel _frameRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiSegmentedToggle _projection = new() { Options = Projections };
        private readonly MuiProgress _progress = new() { Width = 160, Visibility = Visibility.Collapsed };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _stitch = new() { Variant = MuiButtonVariant.Primary, Label = "Stitch" };

        public MuiPanoramaMergeModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 16 };
            body.Children.Add(_frameRow);
            body.Children.Add(new MuiFormField { Label = "Projection", ControlContent = _projection });
            body.Children.Add(_progress);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_cancel);
            footer.Children.Add(_stitch);

            _shell.Header = new MuiText { Text = "Panorama Merge", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _stitch.Click += (_, _) => StitchRequested?.Invoke(this, Projections[_projection.SelectedIndex].Label);

            Rebuild();
        }

        private void Rebuild()
        {
            _frameRow.Children.Clear();
            foreach (var frame in Frames ?? Array.Empty<MuiPanoramaFrame>())
                _frameRow.Children.Add(new MuiMediaCell { Source = frame.Source, Filename = frame.Filename, CellSize = MuiMediaCellSize.Sm });

            _progress.Visibility = IsStitching ? Visibility.Visible : Visibility.Collapsed;
            _stitch.IsEnabled = !IsStitching && (Frames?.Count ?? 0) >= 2;
        }
    }
}
