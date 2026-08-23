using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Everything one Export run needs.</summary>
    public sealed record MuiExportSettings(string Format, string Size, double Quality, string ColorSpace);

    /// <summary>
    /// Maple.UI Export modal organism (unified-component-catalog.md §4.4,
    /// "Export" row: "Format, size, quality, color space", built from
    /// Form Field, Progress, Banner) — on <see cref="MuiOverlayShell"/>
    /// per this section's "all built on Overlay Shell" rule. Each option
    /// is a <see cref="MuiFormField"/> wrapping a
    /// <see cref="MuiSegmentedToggle"/>/<see cref="MuiInput"/>; a
    /// determinate <see cref="MuiProgress"/> replaces the footer's Export
    /// button while <see cref="IsExporting"/>, and a <see cref="MuiBanner"/>
    /// surfaces <see cref="ErrorMessage"/> above the form.
    /// </summary>
    public sealed class MuiExportModal : ContentControl
    {
        private static readonly IReadOnlyList<MuiSegmentedToggleOption> Formats = new[] { new MuiSegmentedToggleOption("JPEG"), new MuiSegmentedToggleOption("TIFF"), new MuiSegmentedToggleOption("DNG") };
        private static readonly IReadOnlyList<MuiSegmentedToggleOption> Sizes = new[] { new MuiSegmentedToggleOption("Full"), new MuiSegmentedToggleOption("2048px"), new MuiSegmentedToggleOption("1024px") };
        private static readonly IReadOnlyList<MuiSegmentedToggleOption> ColorSpaces = new[] { new MuiSegmentedToggleOption("sRGB"), new MuiSegmentedToggleOption("Display P3"), new MuiSegmentedToggleOption("ProPhoto RGB") };

        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiExportModal),
                new PropertyMetadata(false, (d, e) => ((MuiExportModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiExportModal),
                new PropertyMetadata(false, (d, e) => ((MuiExportModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty SettingsProperty =
            DependencyProperty.Register(nameof(Settings), typeof(MuiExportSettings), typeof(MuiExportModal),
                new PropertyMetadata(null, (d, _) => ((MuiExportModal)d).Rebuild()));

        public static readonly DependencyProperty IsExportingProperty =
            DependencyProperty.Register(nameof(IsExporting), typeof(bool), typeof(MuiExportModal),
                new PropertyMetadata(false, (d, _) => ((MuiExportModal)d).Rebuild()));

        public static readonly DependencyProperty ExportProgressProperty =
            DependencyProperty.Register(nameof(ExportProgress), typeof(double), typeof(MuiExportModal),
                new PropertyMetadata(0.0, (d, e) => ((MuiExportModal)d)._progress.Value = (double)e.NewValue));

        public static readonly DependencyProperty ErrorMessageProperty =
            DependencyProperty.Register(nameof(ErrorMessage), typeof(string), typeof(MuiExportModal),
                new PropertyMetadata(null, (d, _) => ((MuiExportModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public MuiExportSettings? Settings { get => (MuiExportSettings?)GetValue(SettingsProperty); set => SetValue(SettingsProperty, value); }
        public bool IsExporting { get => (bool)GetValue(IsExportingProperty); set => SetValue(IsExportingProperty, value); }
        public double ExportProgress { get => (double)GetValue(ExportProgressProperty); set => SetValue(ExportProgressProperty, value); }
        public string? ErrorMessage { get => (string?)GetValue(ErrorMessageProperty); set => SetValue(ErrorMessageProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<MuiExportSettings>? ExportRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Md, AriaLabel = "Export" };
        private readonly MuiBanner _errorBanner = new() { Variant = MuiBannerVariant.Error, Visibility = Visibility.Collapsed };
        private readonly MuiSegmentedToggle _format = new() { Options = Formats };
        private readonly MuiSegmentedToggle _size = new() { Options = Sizes };
        private readonly MuiInput _quality = new() { Variant = MuiInputVariant.Numeric, Minimum = 0, Maximum = 100, NumericValue = 90 };
        private readonly MuiSegmentedToggle _colorSpace = new() { Options = ColorSpaces };
        private readonly MuiProgress _progress = new() { IsIndeterminate = false };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _export = new() { Variant = MuiButtonVariant.Primary, Label = "Export" };

        public MuiExportModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            body.Children.Add(_errorBanner);
            body.Children.Add(new MuiFormField { Label = "Format", ControlContent = _format });
            body.Children.Add(new MuiFormField { Label = "Size", ControlContent = _size });
            body.Children.Add(new MuiFormField { Label = "Quality", ControlContent = _quality });
            body.Children.Add(new MuiFormField { Label = "Color space", ControlContent = _colorSpace });

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_progress);
            footer.Children.Add(_cancel);
            footer.Children.Add(_export);

            _shell.Header = new MuiText { Text = "Export", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _export.Click += (_, _) => ExportRequested?.Invoke(this, new MuiExportSettings(
                _format.Options![_format.SelectedIndex].Label, _size.Options![_size.SelectedIndex].Label,
                _quality.NumericValue, _colorSpace.Options![_colorSpace.SelectedIndex].Label));

            Rebuild();
        }

        private void Rebuild()
        {
            _errorBanner.Visibility = string.IsNullOrEmpty(ErrorMessage) ? Visibility.Collapsed : Visibility.Visible;
            _errorBanner.Message = ErrorMessage ?? string.Empty;

            _progress.Visibility = IsExporting ? Visibility.Visible : Visibility.Collapsed;
            _progress.Width = 100;
            _export.IsEnabled = !IsExporting;
            _cancel.IsEnabled = !IsExporting;

            if (Settings is null) return;
            SelectIndex(_format, Formats, Settings.Format);
            SelectIndex(_size, Sizes, Settings.Size);
            _quality.NumericValue = Settings.Quality;
            SelectIndex(_colorSpace, ColorSpaces, Settings.ColorSpace);
        }

        private static void SelectIndex(MuiSegmentedToggle toggle, IReadOnlyList<MuiSegmentedToggleOption> options, string label)
        {
            for (var i = 0; i < options.Count; i++)
                if (options[i].Label == label) { toggle.SelectedIndex = i; return; }
        }
    }
}
