using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Card molecule (unified-component-catalog.md §3, "Card"
    /// row: "Image + title + metadata tile", built from Image, Text,
    /// Badge) — a pressable tile: a 16:9 image with an optional overlaid
    /// count badge, and a title/subtitle body beneath.
    ///
    /// Ports `mui-card.component.html`'s layout 1:1, including the
    /// image's fixed 16:9 aspect (`[aspectRatio]="16 / 9"`).
    /// </summary>
    public sealed class MuiCard : ContentControl
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiCard),
                new PropertyMetadata(null, (d, _) => ((MuiCard)d).Rebuild()));

        public static readonly DependencyProperty AltProperty =
            DependencyProperty.Register(nameof(Alt), typeof(string), typeof(MuiCard),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiCard)d).Rebuild()));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiCard),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiCard)d).Rebuild()));

        public static readonly DependencyProperty SubtitleProperty =
            DependencyProperty.Register(nameof(Subtitle), typeof(string), typeof(MuiCard),
                new PropertyMetadata(null, (d, _) => ((MuiCard)d).Rebuild()));

        public static readonly DependencyProperty BadgeLabelProperty =
            DependencyProperty.Register(nameof(BadgeLabel), typeof(string), typeof(MuiCard),
                new PropertyMetadata(null, (d, _) => ((MuiCard)d).Rebuild()));

        public ImageSource? Source
        {
            get => (ImageSource?)GetValue(SourceProperty);
            set => SetValue(SourceProperty, value);
        }

        public string Alt
        {
            get => (string)GetValue(AltProperty);
            set => SetValue(AltProperty, value);
        }

        public string Title
        {
            get => (string)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public string? Subtitle
        {
            get => (string?)GetValue(SubtitleProperty);
            set => SetValue(SubtitleProperty, value);
        }

        public string? BadgeLabel
        {
            get => (string?)GetValue(BadgeLabelProperty);
            set => SetValue(BadgeLabelProperty, value);
        }

        public event EventHandler? Pressed;

        private readonly Border _chrome = new() { BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12) };
        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly Grid _mediaHost = new() { Height = 126 };
        private readonly MuiImage _image = new() { Fit = MuiImageFit.Fill };
        private readonly MuiBadge _badge = new()
        {
            Variant = MuiBadgeVariant.Count,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(8),
        };
        // Margin, not Padding — StackPanel's own Padding support is
        // uncertain against this wave's pinned WinAppSDK with no local
        // compiler to check it; Margin (a plain FrameworkElement member)
        // gives the same visual inset for a single no-sibling element.
        private readonly StackPanel _body = new() { Orientation = Orientation.Vertical, Spacing = 4, Margin = new Thickness(12, 10, 12, 10) };
        private readonly MuiText _titleText = new() { Variant = MuiTextVariant.RowLabel, Truncate = true };
        private readonly MuiText _subtitleText = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted, Truncate = true };

        public MuiCard()
        {
            _mediaHost.Children.Add(_image);
            _mediaHost.Children.Add(_badge);
            _body.Children.Add(_titleText);
            _body.Children.Add(_subtitleText);
            _root.Children.Add(_mediaHost);
            _root.Children.Add(_body);
            _chrome.Child = _root;
            Content = _chrome;
            IsTabStop = true;

            Tapped += (_, _) => { if (IsEnabled) Pressed?.Invoke(this, EventArgs.Empty); };
            KeyDown += OnKeyDown;
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled) return;
            if (e.Key != Windows.System.VirtualKey.Enter && e.Key != Windows.System.VirtualKey.Space) return;
            e.Handled = true;
            Pressed?.Invoke(this, EventArgs.Empty);
        }

        private void Rebuild()
        {
            _image.Source = Source;
            _image.AccessibleLabel = Alt;

            _badge.Value = BadgeLabel ?? string.Empty;
            _badge.Visibility = string.IsNullOrEmpty(BadgeLabel) ? Visibility.Collapsed : Visibility.Visible;

            _titleText.Text = Title;
            _subtitleText.Text = Subtitle ?? string.Empty;
            _subtitleText.Visibility = string.IsNullOrEmpty(Subtitle) ? Visibility.Collapsed : Visibility.Visible;

            _chrome.Background = R("MapleSurface");
            _chrome.BorderBrush = R("MapleBorder");

            Opacity = IsEnabled ? 1.0 : 0.45;

            AutomationProperties.SetName(this, Title);
        }
    }
}
