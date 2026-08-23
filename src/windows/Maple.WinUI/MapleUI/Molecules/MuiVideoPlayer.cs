using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Video Player molecule (unified-component-catalog.md §2.7,
    /// "Video Player" row: "Playback with transport controls", built from
    /// Button, Progress, Timestamp) — a poster/frame area above transport
    /// controls: a play/pause toggle, a click-to-seek scrubber
    /// (<see cref="MuiProgress"/> wrapped in a pointer-handling track), and
    /// mm:ss readouts styled like <see cref="MuiText"/>'s ValueChip variant.
    ///
    /// This wave's molecules are presentational specimens with no decoder
    /// wired up (see <see cref="MediaTransportState"/>'s own doc comment) —
    /// the transport state machine is fully live and self-contained (press
    /// play, drag/click the scrubber) via <see cref="Transport"/>; a host
    /// that wires up real playback later drives it from its own media
    /// element's callbacks instead. Matches `mui-video-player.component.ts`'s
    /// own comment: no play/pause glyph exists in the shared icon registry
    /// (MapleIconShapes.cs), so the transport button projects a plain
    /// Unicode triangle/pause-bars label instead of an <see cref="MuiIcon"/>.
    /// </summary>
    public sealed class MuiVideoPlayer : ContentControl
    {
        private const string PlayGlyph = "▶";
        private const string PauseGlyph = "⏸";

        public static readonly DependencyProperty PosterProperty =
            DependencyProperty.Register(nameof(Poster), typeof(ImageSource), typeof(MuiVideoPlayer),
                new PropertyMetadata(null, (d, _) => ((MuiVideoPlayer)d).Rebuild()));

        public static readonly DependencyProperty DurationSecondsProperty =
            DependencyProperty.Register(nameof(DurationSeconds), typeof(double), typeof(MuiVideoPlayer),
                new PropertyMetadata(0.0, (d, e) => ((MuiVideoPlayer)d).Transport.SetDuration((double)e.NewValue)));

        public static readonly DependencyProperty PlayerWidthProperty =
            DependencyProperty.Register(nameof(PlayerWidth), typeof(double), typeof(MuiVideoPlayer),
                new PropertyMetadata(280.0, (d, _) => ((MuiVideoPlayer)d).Rebuild()));

        public ImageSource? Poster
        {
            get => (ImageSource?)GetValue(PosterProperty);
            set => SetValue(PosterProperty, value);
        }

        public double DurationSeconds
        {
            get => (double)GetValue(DurationSecondsProperty);
            set => SetValue(DurationSecondsProperty, value);
        }

        public double PlayerWidth
        {
            get => (double)GetValue(PlayerWidthProperty);
            set => SetValue(PlayerWidthProperty, value);
        }

        /// <summary>The live play/pause/scrub state — a host wiring up real
        /// playback drives it via <c>SetPlaying</c>/<c>SetPosition</c>/
        /// <c>SetDuration</c> from its own media element's callbacks.</summary>
        public MediaTransportState Transport { get; } = new();

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly Border _frameArea = new() { CornerRadius = new CornerRadius(8), Height = 140 };
        private readonly Image _posterImage = new() { Stretch = Stretch.UniformToFill };
        private readonly MuiIcon _frameFallbackIcon = new() { IconName = "filmstrip", Size = MuiIconSize.Lg30 };
        private readonly Grid _transportRow = new();
        private readonly MuiButton _playPauseButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
        private readonly Border _scrubberHost = new() { Height = 20, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiProgress _progress = new() { ProgressShape = MuiProgressShape.Bar };
        private readonly StackPanel _timeRow = new() { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly MuiText _currentTimeText = new() { Variant = MuiTextVariant.ValueChip };
        private readonly MuiText _slashText = new() { Text = "/", Variant = MuiTextVariant.ValueChip };
        private readonly MuiText _durationText = new() { Variant = MuiTextVariant.ValueChip };

        public MuiVideoPlayer()
        {
            var frameHost = new Grid();
            frameHost.Children.Add(_posterImage);
            frameHost.Children.Add(_frameFallbackIcon);
            _frameArea.Child = frameHost;

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

            _root.Children.Add(_frameArea);
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

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _root.Width = PlayerWidth;
            _frameArea.Background = R("MapleImageCanvas");

            var hasPoster = Poster is not null;
            _posterImage.Source = Poster;
            _posterImage.Visibility = hasPoster ? Visibility.Visible : Visibility.Collapsed;
            _frameFallbackIcon.Visibility = hasPoster ? Visibility.Collapsed : Visibility.Visible;

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
