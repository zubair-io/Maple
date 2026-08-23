using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Audio Player molecule (unified-component-catalog.md §2.7,
    /// "Audio Player" row: "Waveform-less audio transport", built from
    /// Button, Progress, Timestamp) — the same play/pause + scrubber + mm:ss
    /// transport row as <see cref="MuiVideoPlayer"/> (see that class's doc
    /// comment for the shared <see cref="MediaTransportState"/>/icon-glyph
    /// reasoning), just without a poster/frame area above it — "waveform-
    /// less" per the catalog, so no visualization sits above the transport.
    /// </summary>
    public sealed class MuiAudioPlayer : ContentControl
    {
        private const string PlayGlyph = "▶";
        private const string PauseGlyph = "⏸";

        public static readonly DependencyProperty DurationSecondsProperty =
            DependencyProperty.Register(nameof(DurationSeconds), typeof(double), typeof(MuiAudioPlayer),
                new PropertyMetadata(0.0, (d, e) => ((MuiAudioPlayer)d).Transport.SetDuration((double)e.NewValue)));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiAudioPlayer),
                new PropertyMetadata(null, (d, _) => ((MuiAudioPlayer)d).Rebuild()));

        public static readonly DependencyProperty PlayerWidthProperty =
            DependencyProperty.Register(nameof(PlayerWidth), typeof(double), typeof(MuiAudioPlayer),
                new PropertyMetadata(280.0, (d, _) => ((MuiAudioPlayer)d).Rebuild()));

        public double DurationSeconds
        {
            get => (double)GetValue(DurationSecondsProperty);
            set => SetValue(DurationSecondsProperty, value);
        }

        /// <summary>An optional track/file name shown above the transport
        /// row. Null renders none.</summary>
        public string? Title
        {
            get => (string?)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public double PlayerWidth
        {
            get => (double)GetValue(PlayerWidthProperty);
            set => SetValue(PlayerWidthProperty, value);
        }

        /// <summary>The live play/pause/scrub state — see
        /// <see cref="MuiVideoPlayer.Transport"/>'s doc comment.</summary>
        public MediaTransportState Transport { get; } = new();

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly MuiText _titleText = new() { Variant = MuiTextVariant.RowLabel, Truncate = true };
        private readonly Grid _transportRow = new();
        private readonly MuiButton _playPauseButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
        private readonly Border _scrubberHost = new() { Height = 20, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiProgress _progress = new() { ProgressShape = MuiProgressShape.Bar };
        private readonly StackPanel _timeRow = new() { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly MuiText _currentTimeText = new() { Variant = MuiTextVariant.ValueChip };
        private readonly MuiText _slashText = new() { Text = "/", Variant = MuiTextVariant.ValueChip };
        private readonly MuiText _durationText = new() { Variant = MuiTextVariant.ValueChip };

        public MuiAudioPlayer()
        {
            _scrubberHost.Child = _progress;
            _scrubberHost.PointerPressed += OnScrubberPressed;

            _timeRow.Children.Add(_currentTimeText);
            _timeRow.Children.Add(_slashText);
            _timeRow.Children.Add(_durationText);

            _transportRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _transportRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _transportRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_playPauseButton, 0);
            Grid.SetColumn(_scrubberHost, 1);
            Grid.SetColumn(_timeRow, 2);
            _transportRow.Children.Add(_playPauseButton);
            _transportRow.Children.Add(_scrubberHost);
            _transportRow.Children.Add(_timeRow);

            _root.Children.Add(_titleText);
            _root.Children.Add(_transportRow);
            Content = _root;
            IsTabStop = false;

            AutomationProperties.SetName(_playPauseButton, "Play");
            _playPauseButton.Click += (_, _) => Transport.TogglePlay();
            Transport.Changed += (_, _) => RebuildTransportVisuals();

            Rebuild();
        }

        private void OnScrubberPressed(object sender, PointerRoutedEventArgs e)
        {
            var width = _scrubberHost.ActualWidth;
            if (width <= 0) return;
            var x = e.GetCurrentPoint(_scrubberHost).Position.X;
            Transport.SeekToRatio(x / width);
            e.Handled = true;
        }

        private void Rebuild()
        {
            _root.Width = PlayerWidth;
            _titleText.Text = Title ?? string.Empty;
            _titleText.Visibility = string.IsNullOrEmpty(Title) ? Visibility.Collapsed : Visibility.Visible;

            RebuildTransportVisuals();
        }

        private void RebuildTransportVisuals()
        {
            _playPauseButton.Label = Transport.IsPlaying ? PauseGlyph : PlayGlyph;
            AutomationProperties.SetName(_playPauseButton, Transport.IsPlaying ? "Pause" : "Play");

            _progress.Value = Transport.ProgressPercent;
            _currentTimeText.Text = Transport.FormattedCurrentTime;
            _durationText.Text = Transport.FormattedDuration;
        }
    }
}
