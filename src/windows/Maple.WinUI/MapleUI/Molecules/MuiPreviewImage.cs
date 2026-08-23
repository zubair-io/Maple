using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Preview Image molecule (unified-component-catalog.md §2.7,
    /// "Preview Image" row: "Static image with load lifecycle", built from
    /// Image, Spinner) — a centered <see cref="MuiSpinner"/> overlay until
    /// the image either loads or fails.
    ///
    /// `mui-preview-image.component.ts` reads `mui-image`'s own
    /// `loaded`/`broken` signals straight off its template-reference
    /// instance. <see cref="MuiImage"/> tracks the same
    /// <see cref="MuiImage.IsBroken"/> state internally but doesn't expose
    /// a load-completion EVENT publicly (only the property) — there's
    /// nothing for an external observer to subscribe to at the moment
    /// decode finishes, and adding one means touching an atom this wave
    /// didn't otherwise need to change with no compiler here to re-verify
    /// it. So this molecule owns a small internal
    /// <see cref="Microsoft.UI.Xaml.Controls.Image"/> directly (the exact
    /// same load/fallback shape <see cref="MuiImage"/> itself uses) instead
    /// of nesting a MuiImage instance — a complete, working implementation
    /// of the described lifecycle, just composed one level lower so this
    /// control can observe <see cref="Microsoft.UI.Xaml.Controls.Image.ImageOpened"/>/
    /// <see cref="Microsoft.UI.Xaml.Controls.Image.ImageFailed"/> directly.
    /// </summary>
    public sealed class MuiPreviewImage : ContentControl
    {
        private enum LoadState { Loading, Loaded, Broken }

        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiPreviewImage),
                new PropertyMetadata(null, (d, _) => ((MuiPreviewImage)d).OnSourceChanged()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiPreviewImage),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiPreviewImage)d).Rebuild()));

        public static readonly DependencyProperty FitProperty =
            DependencyProperty.Register(nameof(Fit), typeof(MuiImageFit), typeof(MuiPreviewImage),
                new PropertyMetadata(MuiImageFit.Fill, (d, _) => ((MuiPreviewImage)d).Rebuild()));

        public static readonly DependencyProperty ImageCornerRadiusProperty =
            DependencyProperty.Register(nameof(ImageCornerRadius), typeof(double), typeof(MuiPreviewImage),
                new PropertyMetadata(8.0, (d, _) => ((MuiPreviewImage)d).Rebuild()));

        public ImageSource? Source
        {
            get => (ImageSource?)GetValue(SourceProperty);
            set => SetValue(SourceProperty, value);
        }

        public string AccessibleLabel
        {
            get => (string)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
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

        private readonly Border _frame = new();
        private readonly Grid _host = new();
        private readonly Image _image = new();
        private readonly Grid _fallback = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiIcon _fallbackIcon = new() { IconName = "photos", Size = MuiIconSize.Lg30 };
        private readonly MuiSpinner _spinner = new() { SpinnerSize = MuiSpinnerSize.Md };

        private LoadState _state = LoadState.Loading;

        public MuiPreviewImage()
        {
            _fallback.Children.Add(_fallbackIcon);
            _host.Children.Add(_image);
            _host.Children.Add(_fallback);
            _host.Children.Add(_spinner);
            _frame.Child = _host;
            Content = _frame;
            IsTabStop = false;
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Content);

            _image.ImageOpened += (_, _) => { _state = LoadState.Loaded; Rebuild(); };
            _image.ImageFailed += (_, _) => { _state = LoadState.Broken; Rebuild(); };

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnSourceChanged()
        {
            _state = LoadState.Loading;
            Rebuild();
        }

        private void Rebuild()
        {
            _frame.CornerRadius = new CornerRadius(ImageCornerRadius);
            _frame.Background = R("MapleSurfaceAlt");

            _image.Source = Source;
            _image.Stretch = Fit == MuiImageFit.Fill ? Stretch.UniformToFill : Stretch.Uniform;
            _image.Visibility = _state == LoadState.Loaded ? Visibility.Visible : Visibility.Collapsed;

            _fallback.Visibility = _state == LoadState.Broken ? Visibility.Visible : Visibility.Collapsed;

            _spinner.IsSpinning = _state == LoadState.Loading;
            _spinner.Visibility = _state == LoadState.Loading ? Visibility.Visible : Visibility.Collapsed;

            if (!string.IsNullOrEmpty(AccessibleLabel))
                AutomationProperties.SetName(this, AccessibleLabel);
        }
    }
}
