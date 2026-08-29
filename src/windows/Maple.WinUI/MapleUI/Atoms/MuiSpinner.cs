using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Spinner size (unified-component-catalog.md §1.5 Feedback,
    /// "Spinner" row: "Sizes: sm, md").</summary>
    public enum MuiSpinnerSize { Sm, Md }

    /// <summary>
    /// Maple.UI Spinner atom (unified-component-catalog.md §1.5 Feedback,
    /// "Spinner" row: "Small indeterminate indicator · Inline vs. centered ·
    /// Delay-before-show threshold").
    ///
    /// A thin wrapper over <see cref="ProgressRing"/> whose whole point is
    /// the delay: <see cref="IsSpinning"/> flipping true doesn't show
    /// anything immediately — a `DispatcherTimer` waits <see cref="DelayMs"/>
    /// first, so a sub-threshold operation (e.g. a cache hit that resolves
    /// in 20ms) never flashes a spinner at all. Flipping IsSpinning back to
    /// false at any point cancels the pending timer and hides immediately —
    /// there is no matching "delay before hide".
    ///
    /// No exact delay-before-show number is specified in the catalog row —
    /// 400ms is used as a reasonable default (the commonly-cited UX
    /// threshold below which a spinner reads as more distracting than
    /// informative), flagged here the same way MuiButton flags its
    /// unspecified Sm/Lg pixel steps.
    /// </summary>
    public sealed class MuiSpinner : ContentControl
    {
        public static readonly DependencyProperty IsSpinningProperty =
            DependencyProperty.Register(nameof(IsSpinning), typeof(bool), typeof(MuiSpinner),
                new PropertyMetadata(false, (d, e) => ((MuiSpinner)d).OnIsSpinningChanged((bool)e.NewValue)));

        public static readonly DependencyProperty SpinnerSizeProperty =
            DependencyProperty.Register(nameof(SpinnerSize), typeof(MuiSpinnerSize), typeof(MuiSpinner),
                new PropertyMetadata(MuiSpinnerSize.Md, (d, _) => ((MuiSpinner)d).ApplySize()));

        public static readonly DependencyProperty InlineProperty =
            DependencyProperty.Register(nameof(Inline), typeof(bool), typeof(MuiSpinner),
                new PropertyMetadata(false, (d, _) => ((MuiSpinner)d).ApplySize()));

        public static readonly DependencyProperty DelayMsProperty =
            DependencyProperty.Register(nameof(DelayMs), typeof(int), typeof(MuiSpinner),
                new PropertyMetadata(400));

        public bool IsSpinning
        {
            get => (bool)GetValue(IsSpinningProperty);
            set => SetValue(IsSpinningProperty, value);
        }

        public MuiSpinnerSize SpinnerSize
        {
            get => (MuiSpinnerSize)GetValue(SpinnerSizeProperty);
            set => SetValue(SpinnerSizeProperty, value);
        }

        /// <summary>Inline (left-aligned, sits beside text) vs. centered
        /// (fills and centers within whatever space the host gives it).</summary>
        public bool Inline
        {
            get => (bool)GetValue(InlineProperty);
            set => SetValue(InlineProperty, value);
        }

        public int DelayMs
        {
            get => (int)GetValue(DelayMsProperty);
            set => SetValue(DelayMsProperty, value);
        }

        private readonly ProgressRing _ring = new() { IsActive = false, Visibility = Visibility.Collapsed };
        private readonly DispatcherTimer _delayTimer = new();

        public MuiSpinner()
        {
            Content = _ring;
            IsTabStop = false;

            // #3069: ProgressRing's default Foreground is the system accent
            // color — the spinner rendered in whatever accent Windows is set
            // to instead of Maple primary (MuiProgress's ring already pins
            // this; this wrapper missed it).
            _ring.Foreground = (Brush)Application.Current.Resources["MaplePrimary"];

            _delayTimer.Tick += (_, _) =>
            {
                _delayTimer.Stop();
                if (IsSpinning)
                {
                    _ring.IsActive = true;
                    _ring.Visibility = Visibility.Visible;
                }
            };

            ApplySize();
        }

        private void OnIsSpinningChanged(bool isSpinning)
        {
            _delayTimer.Stop();

            if (!isSpinning)
            {
                _ring.IsActive = false;
                _ring.Visibility = Visibility.Collapsed;
                return;
            }

            _delayTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(0, DelayMs));
            _delayTimer.Start();
        }

        private void ApplySize()
        {
            var diameter = SpinnerSize == MuiSpinnerSize.Sm ? 16 : 24;
            _ring.Width = diameter;
            _ring.Height = diameter;
            HorizontalAlignment = Inline ? HorizontalAlignment.Left : HorizontalAlignment.Center;
            VerticalAlignment = Inline ? VerticalAlignment.Center : VerticalAlignment.Center;
        }
    }
}
