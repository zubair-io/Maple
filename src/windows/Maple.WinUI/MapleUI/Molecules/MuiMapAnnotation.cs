using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Map Annotation molecule (unified-component-catalog.md §2.7,
    /// "Map Annotation" row: "Thumbnail pin or count cluster", built from
    /// Image, Badge, Text) — a circular thumbnail pin (or a fallback "map
    /// pin" glyph when no photo is given) with an optional cluster-count
    /// badge and caption. Ports `mui-map-annotation.component.ts`'s three
    /// inputs (src/label/count).
    /// </summary>
    public sealed class MuiMapAnnotation : ContentControl
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiMapAnnotation),
                new PropertyMetadata(null, (d, _) => ((MuiMapAnnotation)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiMapAnnotation),
                new PropertyMetadata(null, (d, _) => ((MuiMapAnnotation)d).Rebuild()));

        public static readonly DependencyProperty CountProperty =
            DependencyProperty.Register(nameof(Count), typeof(int?), typeof(MuiMapAnnotation),
                new PropertyMetadata(null, (d, _) => ((MuiMapAnnotation)d).Rebuild()));

        public static readonly DependencyProperty PinSizeProperty =
            DependencyProperty.Register(nameof(PinSize), typeof(double), typeof(MuiMapAnnotation),
                new PropertyMetadata(40.0, (d, _) => ((MuiMapAnnotation)d).Rebuild()));

        public ImageSource? Source
        {
            get => (ImageSource?)GetValue(SourceProperty);
            set => SetValue(SourceProperty, value);
        }

        public string? Label
        {
            get => (string?)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        /// <summary>A cluster count badge; null/0 hides it.</summary>
        public int? Count
        {
            get => (int?)GetValue(CountProperty);
            set => SetValue(CountProperty, value);
        }

        public double PinSize
        {
            get => (double)GetValue(PinSizeProperty);
            set => SetValue(PinSizeProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly Grid _pinHost = new();
        private readonly Border _circle = new() { BorderThickness = new Thickness(2) };
        private readonly Grid _circleInner = new();
        private readonly Image _image = new() { Stretch = Stretch.UniformToFill };
        private readonly MuiIcon _fallbackIcon = new() { IconName = "map-pin", Size = MuiIconSize.Sm16 };
        private readonly MuiBadge _countBadge = new()
        {
            Variant = MuiBadgeVariant.Count,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, -6, -6, 0),
        };
        private readonly MuiText _captionText = new() { Variant = MuiTextVariant.ValueChip, HorizontalAlignment = HorizontalAlignment.Center };

        public MuiMapAnnotation()
        {
            _circleInner.Children.Add(_image);
            _circleInner.Children.Add(_fallbackIcon);
            _circle.Child = _circleInner;
            _pinHost.Children.Add(_circle);
            _pinHost.Children.Add(_countBadge);
            _root.Children.Add(_pinHost);
            _root.Children.Add(_captionText);
            Content = _root;
            IsTabStop = false;

            _image.ImageFailed += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _circle.Width = PinSize;
            _circle.Height = PinSize;
            _circle.CornerRadius = new CornerRadius(PinSize / 2);
            _circle.Background = R("MapleSurfaceAlt");
            _circle.BorderBrush = R("MapleBg");

            var hasSource = Source is not null;
            _image.Source = Source;
            _image.Visibility = hasSource ? Visibility.Visible : Visibility.Collapsed;
            _fallbackIcon.Visibility = hasSource ? Visibility.Collapsed : Visibility.Visible;

            var count = Count ?? 0;
            _countBadge.Value = count.ToString();
            _countBadge.Label = count + (count == 1 ? " photo" : " photos");
            _countBadge.Visibility = count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _captionText.Text = Label ?? string.Empty;
            _captionText.Visibility = string.IsNullOrEmpty(Label) ? Visibility.Collapsed : Visibility.Visible;
        }
    }
}
