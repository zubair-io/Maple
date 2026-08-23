using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace Maple.UI.Atoms
{
    /// <summary>Toast variant (unified-component-catalog.md §1.5 Feedback,
    /// "Toast" row: "Variants: info, success, warning, error").</summary>
    public enum MuiToastVariant { Info, Success, Warning, Error }

    /// <summary>
    /// Maple.UI Toast atom (unified-component-catalog.md §1.5 Feedback,
    /// "Toast" row: "Transient notification · With/without action ·
    /// Auto-dismiss timing · Enter/exit motion").
    ///
    /// The countdown itself lives in the WinUI-free
    /// <see cref="MuiToastAutoDismissTimer"/> (unit-tested in
    /// Maple.WinUI.Tests); this control only ticks a real
    /// <see cref="DispatcherTimer"/> into it every 100ms and reacts to
    /// <see cref="MuiToastAutoDismissTimer.DismissRequested"/>. Hovering
    /// pauses the countdown (PointerEntered/PointerExited), a common toast
    /// UX the timer's Pause/Resume already supports directly.
    ///
    /// Enter/exit motion is a simple opacity fade (Loaded -> fade in;
    /// <see cref="Dismiss"/> -> fade out, then <see cref="Dismissed"/>
    /// fires) — the same conservative single-Storyboard-property approach
    /// MuiSegmentedToggle's pill motion uses, since this wave has no
    /// compiler to verify a fancier animation against. Actually removing
    /// the dismissed toast from a host list (e.g. a future Toast Container
    /// molecule) is the listener's job, not this control's.
    /// </summary>
    public sealed class MuiToast : ContentControl
    {
        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiToastVariant), typeof(MuiToast),
                new PropertyMetadata(MuiToastVariant.Info, (d, _) => ((MuiToast)d).Rebuild()));

        public static readonly DependencyProperty MessageProperty =
            DependencyProperty.Register(nameof(Message), typeof(string), typeof(MuiToast),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiToast)d).Rebuild()));

        public static readonly DependencyProperty ActionLabelProperty =
            DependencyProperty.Register(nameof(ActionLabel), typeof(string), typeof(MuiToast),
                new PropertyMetadata(null, (d, _) => ((MuiToast)d).Rebuild()));

        public static readonly DependencyProperty AutoDismissMsProperty =
            DependencyProperty.Register(nameof(AutoDismissMs), typeof(int?), typeof(MuiToast),
                new PropertyMetadata(null, (d, _) => ((MuiToast)d).RebuildDismissTimer()));

        public MuiToastVariant Variant
        {
            get => (MuiToastVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        public string Message
        {
            get => (string)GetValue(MessageProperty);
            set => SetValue(MessageProperty, value);
        }

        /// <summary>Null (the default) renders no action button.</summary>
        public string? ActionLabel
        {
            get => (string?)GetValue(ActionLabelProperty);
            set => SetValue(ActionLabelProperty, value);
        }

        /// <summary>Null (the default) means no auto-dismiss — the toast
        /// stays until <see cref="Dismiss"/> is called explicitly (e.g. from
        /// a close button in the host's Toast Container).</summary>
        public int? AutoDismissMs
        {
            get => (int?)GetValue(AutoDismissMsProperty);
            set => SetValue(AutoDismissMsProperty, value);
        }

        /// <summary>Raised when the action button is pressed.</summary>
        public event EventHandler? ActionRequested;

        /// <summary>Raised once the exit fade completes — the host should
        /// remove this toast from its visual tree now.</summary>
        public event EventHandler? Dismissed;

        private readonly Border _card = new() { CornerRadius = new CornerRadius(10), BorderThickness = new Thickness(1), Padding = new Thickness(12, 10, 12, 10) };
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 10 };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Sm16 };
        private readonly TextBlock _message = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, MaxWidth = 260 };
        private readonly MuiButton _actionButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
        private readonly Button _closeButton = new()
        {
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(2),
            MinWidth = 0,
            MinHeight = 0,
        };

        private readonly DispatcherTimer _tickTimer = new() { Interval = TimeSpan.FromMilliseconds(100) };
        private MuiToastAutoDismissTimer? _dismissTimer;
        private bool _isDismissing;

        public MuiToast()
        {
            _row.Children.Add(_icon);
            _row.Children.Add(_message);
            _row.Children.Add(_actionButton);
            _closeButton.Content = new MuiIcon { IconName = "x", Size = MuiIconSize.Xs14 };
            _row.Children.Add(_closeButton);
            _card.Child = _row;
            Content = _card;
            IsTabStop = false;
            Opacity = 0;

            _actionButton.Click += (_, _) => ActionRequested?.Invoke(this, EventArgs.Empty);
            _closeButton.Click += (_, _) => Dismiss();
            PointerEntered += (_, _) => _dismissTimer?.Pause();
            PointerExited += (_, _) => _dismissTimer?.Resume();
            _tickTimer.Tick += (_, _) => _dismissTimer?.Tick(_tickTimer.Interval);
            Loaded += (_, _) => PlayEnter();

            Rebuild();
            RebuildDismissTimer();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void RebuildDismissTimer()
        {
            _tickTimer.Stop();
            _dismissTimer = null;

            if (AutoDismissMs is not { } ms || ms <= 0)
                return;

            _dismissTimer = new MuiToastAutoDismissTimer(TimeSpan.FromMilliseconds(ms));
            _dismissTimer.DismissRequested += () => DispatcherQueue.TryEnqueue(Dismiss);
            _tickTimer.Start();
        }

        private void Rebuild()
        {
            var (bg, border, fg, iconName) = Variant switch
            {
                MuiToastVariant.Success => (R("MapleSuccessBg"), R("MapleSuccessText"), R("MapleSuccessText"), "check"),
                MuiToastVariant.Warning => (R("MaplePrimaryDim"), R("MapleWarn"), R("MapleWarn"), "flag"),
                MuiToastVariant.Error => (R("MapleErrorBg"), R("MapleErrorText"), R("MapleErrorText"), "x"),
                _ => (R("MapleSurfaceAlt"), R("MapleBorder"), R("MapleTextMain"), "info"),
            };

            _card.Background = bg;
            _card.BorderBrush = border;
            _icon.IconName = iconName;
            _icon.IconColor = fg;
            _message.Text = Message;
            _message.Foreground = R("MapleTextMain");

            _actionButton.Label = ActionLabel ?? string.Empty;
            _actionButton.Visibility = string.IsNullOrEmpty(ActionLabel) ? Visibility.Collapsed : Visibility.Visible;

            if (!string.IsNullOrEmpty(Message))
                AutomationProperties.SetName(this, Message);
        }

        private void PlayEnter()
        {
            var anim = new DoubleAnimation
            {
                From = 0,
                To = 1,
                Duration = new Duration(TimeSpan.FromMilliseconds(180)),
            };
            Storyboard.SetTarget(anim, this);
            Storyboard.SetTargetProperty(anim, "Opacity");
            var storyboard = new Storyboard();
            storyboard.Children.Add(anim);
            storyboard.Begin();
        }

        /// <summary>Plays the exit fade, then raises <see cref="Dismissed"/>.
        /// Safe to call multiple times (a second call while fading is a
        /// no-op).</summary>
        public void Dismiss()
        {
            if (_isDismissing) return;
            _isDismissing = true;
            _tickTimer.Stop();

            var anim = new DoubleAnimation
            {
                To = 0,
                Duration = new Duration(TimeSpan.FromMilliseconds(150)),
            };
            var storyboard = new Storyboard();
            Storyboard.SetTarget(anim, this);
            Storyboard.SetTargetProperty(anim, "Opacity");
            storyboard.Children.Add(anim);
            storyboard.Completed += (_, _) => Dismissed?.Invoke(this, EventArgs.Empty);
            storyboard.Begin();
        }
    }
}
