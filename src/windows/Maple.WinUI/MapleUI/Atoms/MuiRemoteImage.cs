using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Maple.UI Remote Image atom (unified-component-catalog.md §1.4 Media,
    /// "Remote Image" row: "Authenticated, cached, tiered load · Tiers:
    /// thumb -> preview -> full · Blur-up transition · Retry affordance").
    ///
    /// The actual fetch (auth, caching, networking) is the host's job — this
    /// control only renders whatever <see cref="MuiRemoteImageLoader{TImage}"/>
    /// it's handed, wired to `ImageSource`. That split keeps the sequencing
    /// logic (thumb -> preview -> full, retry, hard-vs-soft failure) in the
    /// WinUI-free <see cref="MuiRemoteImageLoader{TImage}"/> class where it's
    /// unit-testable in Maple.WinUI.Tests, and keeps this class limited to
    /// what actually needs a live Window: an <see cref="Image"/>, a loading
    /// ring, and a retry button.
    ///
    /// "Blur-up transition" here is a short opacity pulse on each tier swap
    /// (a single <see cref="Image"/> element, not a true two-layer
    /// crossfade) — the simplest motion this wave can ship without a
    /// compiler to verify a fancier Storyboard against, same reasoning
    /// MuiSegmentedToggle's pill animation gives.
    /// </summary>
    public sealed class MuiRemoteImage : ContentControl
    {
        public static readonly DependencyProperty LoaderProperty =
            DependencyProperty.Register(nameof(Loader), typeof(MuiRemoteImageLoader<ImageSource>), typeof(MuiRemoteImage),
                new PropertyMetadata(null, (d, e) => ((MuiRemoteImage)d).OnLoaderChanged((MuiRemoteImageLoader<ImageSource>?)e.OldValue, (MuiRemoteImageLoader<ImageSource>?)e.NewValue)));

        public static readonly DependencyProperty ImageCornerRadiusProperty =
            DependencyProperty.Register(nameof(ImageCornerRadius), typeof(double), typeof(MuiRemoteImage),
                new PropertyMetadata(0.0, (d, _) => ((MuiRemoteImage)d).ApplyChrome()));

        /// <summary>Host-supplied tiered loader. Setting a new one cancels
        /// and unsubscribes from any previous loader and calls Start() on
        /// the new one.</summary>
        public MuiRemoteImageLoader<ImageSource>? Loader
        {
            get => (MuiRemoteImageLoader<ImageSource>?)GetValue(LoaderProperty);
            set => SetValue(LoaderProperty, value);
        }

        public double ImageCornerRadius
        {
            get => (double)GetValue(ImageCornerRadiusProperty);
            set => SetValue(ImageCornerRadiusProperty, value);
        }

        private readonly Border _frame = new();
        private readonly Grid _stack = new();
        private readonly Image _image = new() { Stretch = Stretch.UniformToFill };
        private readonly ProgressRing _spinner = new() { Width = 28, Height = 28, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly StackPanel _retryPanel = new() { Orientation = Orientation.Vertical, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiButton _retryButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Retry", IconName = "revert" };

        private bool _hasPendingFailure;

        public MuiRemoteImage()
        {
            _stack.Children.Add(_image);
            _stack.Children.Add(_spinner);
            _retryPanel.Children.Add(new MuiIcon { IconName = "revert", Size = MuiIconSize.Md24 });
            _retryPanel.Children.Add(_retryButton);
            _stack.Children.Add(_retryPanel);
            _frame.Child = _stack;
            Content = _frame;
            IsTabStop = false;

            _retryButton.Click += (_, _) => Loader?.Retry();

            ApplyChrome();
            ApplyVisualState();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void ApplyChrome()
        {
            _frame.CornerRadius = new CornerRadius(ImageCornerRadius);
            _frame.Background = R("MapleSurfaceAlt");
        }

        private void OnLoaderChanged(MuiRemoteImageLoader<ImageSource>? oldLoader, MuiRemoteImageLoader<ImageSource>? newLoader)
        {
            if (oldLoader is not null)
            {
                oldLoader.TierReady -= OnTierReady;
                oldLoader.TierFailed -= OnTierFailed;
                oldLoader.Cancel();
            }

            _image.Source = null;
            _hasPendingFailure = false;

            if (newLoader is not null)
            {
                newLoader.TierReady += OnTierReady;
                newLoader.TierFailed += OnTierFailed;
                _ = newLoader.Start();
            }

            ApplyVisualState();
        }

        private void OnTierReady(MuiRemoteImageTier tier, ImageSource image)
        {
            DispatcherQueue.TryEnqueue(() =>
            {
                _hasPendingFailure = false;
                _image.Source = image;
                PulseOpacity();
                ApplyVisualState();
            });
        }

        private void OnTierFailed(MuiRemoteImageTier tier, System.Exception error)
        {
            DispatcherQueue.TryEnqueue(() =>
            {
                _hasPendingFailure = true;
                ApplyVisualState();
            });
        }

        private void PulseOpacity()
        {
            _image.Opacity = 0;
            var anim = new DoubleAnimation
            {
                From = 0,
                To = 1,
                Duration = new Duration(System.TimeSpan.FromMilliseconds(180)),
            };
            Storyboard.SetTarget(anim, _image);
            Storyboard.SetTargetProperty(anim, "Opacity");
            var storyboard = new Storyboard();
            storyboard.Children.Add(anim);
            storyboard.Begin();
        }

        private void ApplyVisualState()
        {
            var state = Loader?.State ?? MuiRemoteImageLoadState.Idle;
            var hasAnyImage = _image.Source is not null;

            _spinner.IsActive = state == MuiRemoteImageLoadState.Loading && !hasAnyImage;
            _spinner.Visibility = _spinner.IsActive ? Visibility.Visible : Visibility.Collapsed;

            var hardFailure = state == MuiRemoteImageLoadState.Failed && !hasAnyImage;
            _retryPanel.Visibility = hardFailure || (_hasPendingFailure && !hasAnyImage) ? Visibility.Visible : Visibility.Collapsed;

            _image.Visibility = hasAnyImage ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
