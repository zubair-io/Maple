using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Backup Monitor organism (unified-component-catalog.md
    /// §4.8, "Backup Monitor" row: "Configuration plus live progress",
    /// built from Form Field, Progress, Banner) — a destination
    /// <see cref="MuiFormField"/>, a determinate <see cref="MuiProgress"/>
    /// while a backup runs, and a <see cref="MuiBanner"/> for the last
    /// run's outcome.
    /// </summary>
    public sealed class MuiBackupMonitor : ContentControl
    {
        public static readonly DependencyProperty DestinationProperty =
            DependencyProperty.Register(nameof(Destination), typeof(string), typeof(MuiBackupMonitor),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiBackupMonitor)d)._destination.Text = (string)e.NewValue));

        public static readonly DependencyProperty IsRunningProperty =
            DependencyProperty.Register(nameof(IsRunning), typeof(bool), typeof(MuiBackupMonitor),
                new PropertyMetadata(false, (d, _) => ((MuiBackupMonitor)d).Rebuild()));

        public static readonly DependencyProperty ProgressPercentProperty =
            DependencyProperty.Register(nameof(ProgressPercent), typeof(double), typeof(MuiBackupMonitor),
                new PropertyMetadata(0.0, (d, e) => ((MuiBackupMonitor)d)._progress.Value = (double)e.NewValue));

        public static readonly DependencyProperty StatusMessageProperty =
            DependencyProperty.Register(nameof(StatusMessage), typeof(string), typeof(MuiBackupMonitor),
                new PropertyMetadata(null, (d, _) => ((MuiBackupMonitor)d).Rebuild()));

        public static readonly DependencyProperty StatusVariantProperty =
            DependencyProperty.Register(nameof(StatusVariant), typeof(MuiBannerVariant), typeof(MuiBackupMonitor),
                new PropertyMetadata(MuiBannerVariant.Info, (d, e) => ((MuiBackupMonitor)d)._banner.Variant = (MuiBannerVariant)e.NewValue));

        public string Destination { get => (string)GetValue(DestinationProperty); set => SetValue(DestinationProperty, value); }
        public bool IsRunning { get => (bool)GetValue(IsRunningProperty); set => SetValue(IsRunningProperty, value); }
        public double ProgressPercent { get => (double)GetValue(ProgressPercentProperty); set => SetValue(ProgressPercentProperty, value); }
        public string? StatusMessage { get => (string?)GetValue(StatusMessageProperty); set => SetValue(StatusMessageProperty, value); }
        public MuiBannerVariant StatusVariant { get => (MuiBannerVariant)GetValue(StatusVariantProperty); set => SetValue(StatusVariantProperty, value); }

        public event EventHandler<string>? DestinationCommitted;
        public event EventHandler? RunNowRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 14 };
        private readonly MuiInput _destination = new() { Placeholder = "smb://backup-nas/maple" };
        private readonly MuiButton _runNow = new() { Variant = MuiButtonVariant.Secondary, Label = "Run now" };
        private readonly MuiProgress _progress = new() { Visibility = Visibility.Collapsed };
        private readonly MuiBanner _banner = new() { Visibility = Visibility.Collapsed };

        public MuiBackupMonitor()
        {
            var destRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            destRow.Children.Add(_destination);
            destRow.Children.Add(_runNow);

            _root.Children.Add(new MuiFormField { Label = "Backup destination", ControlContent = destRow });
            _root.Children.Add(_progress);
            _root.Children.Add(_banner);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _destination.Committed += (_, text) => { Destination = text; DestinationCommitted?.Invoke(this, text); };
            _runNow.Click += (_, _) => RunNowRequested?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            _progress.Visibility = IsRunning ? Visibility.Visible : Visibility.Collapsed;
            _progress.Width = 200;
            _runNow.IsEnabled = !IsRunning;

            _banner.Visibility = string.IsNullOrEmpty(StatusMessage) ? Visibility.Collapsed : Visibility.Visible;
            _banner.Message = StatusMessage ?? string.Empty;
        }
    }
}
