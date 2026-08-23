using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>Image fit mode (unified-component-catalog.md §1.4 Media,
    /// "Image" row: "Fit modes: fill, fit").</summary>
    public enum MuiImageFit { Fill, Uniform }

    /// <summary>
    /// Maple.UI Image atom (unified-component-catalog.md §1.4 Media, "Image"
    /// row: "Raster leaf · Fit modes: fill, fit · Radii · Placeholder and
    /// broken states · Aspect handling") — a plain local/decoded raster
    /// leaf, distinct from MuiRemoteImage's tiered authenticated fetch.
    ///
    /// Radius is applied via the wrapping <see cref="Border"/>'s
    /// CornerRadius, which WinUI clips its Child content to natively (no
    /// separate Clip geometry needed). Broken-state handling listens for
    /// <see cref="Image.ImageFailed"/> and swaps to a centered fallback
    /// glyph over a muted surface — the registry has no dedicated
    /// "broken image" icon (adding one means hand-syncing the Web/Apple
    /// registries too, per MapleIconShapes.cs's own header comment, out of
    /// scope for this wave), so the existing "photos" glyph is reused as
    /// the closest available semantic fit.
    /// </summary>
    public sealed class MuiImage : ContentControl
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiImage),
                new PropertyMetadata(null, (d, _) => ((MuiImage)d).Rebuild()));

        public static readonly DependencyProperty FitProperty =
            DependencyProperty.Register(nameof(Fit), typeof(MuiImageFit), typeof(MuiImage),
                new PropertyMetadata(MuiImageFit.Uniform, (d, _) => ((MuiImage)d).Rebuild()));

        public static readonly DependencyProperty ImageCornerRadiusProperty =
            DependencyProperty.Register(nameof(ImageCornerRadius), typeof(double), typeof(MuiImage),
                new PropertyMetadata(0.0, (d, _) => ((MuiImage)d).Rebuild()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiImage),
                new PropertyMetadata(null, (d, _) => ((MuiImage)d).Rebuild()));

        public ImageSource? Source
        {
            get => (ImageSource?)GetValue(SourceProperty);
            set => SetValue(SourceProperty, value);
        }

        public MuiImageFit Fit
        {
            get => (MuiImageFit)GetValue(FitProperty);
            set => SetValue(FitProperty, value);
        }

        public double ImageCornerRadius
        {
            get => (double)GetValue(ImageCornerRadiusProperty);
            set => SetValue(ImageCornerRadiusProperty, value);
        }

        /// <summary>Photos are content, not decoration — set this (e.g. a
        /// caption or filename) so assistive tech has something to announce.</summary>
        public string? AccessibleLabel
        {
            get => (string?)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
        }

        /// <summary>True once <see cref="Image.ImageFailed"/> has fired for
        /// the current Source.</summary>
        public bool IsBroken { get; private set; }

        private readonly Border _frame = new();
        private readonly Image _image = new();
        private readonly Grid _fallback = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiIcon _fallbackIcon = new() { IconName = "photos", Size = MuiIconSize.Lg30 };

        public MuiImage()
        {
            _fallback.Children.Add(_fallbackIcon);
            var host = new Grid();
            host.Children.Add(_image);
            host.Children.Add(_fallback);
            _frame.Child = host;
            Content = _frame;
            IsTabStop = false;
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Content);

            _image.ImageFailed += (_, _) =>
            {
                IsBroken = true;
                Rebuild();
            };
            _image.ImageOpened += (_, _) =>
            {
                IsBroken = false;
                Rebuild();
            };

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _frame.CornerRadius = new CornerRadius(ImageCornerRadius);
            _frame.Background = R("MapleSurfaceAlt");

            _image.Source = Source;
            _image.Stretch = Fit == MuiImageFit.Fill ? Stretch.UniformToFill : Stretch.Uniform;
            _image.Visibility = IsBroken || Source is null ? Visibility.Collapsed : Visibility.Visible;

            _fallback.Visibility = IsBroken || Source is null ? Visibility.Visible : Visibility.Collapsed;

            if (!string.IsNullOrEmpty(AccessibleLabel))
                AutomationProperties.SetName(this, AccessibleLabel!);
        }
    }
}
