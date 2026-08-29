using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Maple.UI Canvas Surface atom (unified-component-catalog.md §1.4
    /// Media, "Canvas Surface" row: "Hosts a GPU-rendered layer · Letterbox
    /// behavior · Background · Loading state before first frame").
    ///
    /// This is a letterbox HOST, not a renderer: it owns the background
    /// fill, centers/letterboxes whatever content it's given, and shows a
    /// loading spinner before <see cref="HostedContent"/> is set. It does
    /// NOT create a swap chain or touch DirectX/Win2D itself — this app's
    /// actual GPU preview surface (built elsewhere, on top of the existing
    /// `raw_ffi`/Metal-equivalent Windows GPU pipeline once that lands) is
    /// expected to compose into <see cref="HostedContent"/> as a
    /// SwapChainPanel or similar, later. Exposing a typed `HostedContent`
    /// slot rather than the inherited `Content` keeps this consistent with
    /// every other Maple.UI atom, which always sets its OWN `Content` to an
    /// internally composed tree (see MuiBadge/MuiStat/MuiList for
    /// precedent) — `HostedContent` is this atom's one true variable slot.
    /// </summary>
    public sealed class MuiCanvasSurface : ContentControl
    {
        public static readonly DependencyProperty HostedContentProperty =
            DependencyProperty.Register(nameof(HostedContent), typeof(UIElement), typeof(MuiCanvasSurface),
                new PropertyMetadata(null, (d, _) => ((MuiCanvasSurface)d).Rebuild()));

        public static readonly DependencyProperty IsLoadingProperty =
            DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(MuiCanvasSurface),
                new PropertyMetadata(true, (d, _) => ((MuiCanvasSurface)d).Rebuild()));

        /// <summary>The GPU/preview layer this surface letterboxes. Null
        /// renders just the background + (if IsLoading) the spinner.</summary>
        public UIElement? HostedContent
        {
            get => (UIElement?)GetValue(HostedContentProperty);
            set => SetValue(HostedContentProperty, value);
        }

        /// <summary>True before the first frame has rendered — shows a
        /// centered spinner over the letterbox background. Defaults true:
        /// a surface with nothing hosted yet IS the "before first frame"
        /// state.</summary>
        public bool IsLoading
        {
            get => (bool)GetValue(IsLoadingProperty);
            set => SetValue(IsLoadingProperty, value);
        }

        private readonly Grid _root = new();
        private readonly Grid _hostSlot = new();
        private readonly ProgressRing _spinner = new()
        {
            Width = 32,
            Height = 32,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };

        public MuiCanvasSurface()
        {
            _root.Children.Add(_hostSlot);
            _root.Children.Add(_spinner);
            Content = _root;
            IsTabStop = false;

            // #3069: same ProgressRing system-accent default as MuiSpinner —
            // pin the loading ring to Maple primary.
            _spinner.Foreground = R("MaplePrimary");

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            // color.image_canvas: the same letterbox background token the
            // existing image/preview surfaces use elsewhere in this app.
            _root.Background = R("MapleImageCanvas");

            _hostSlot.Children.Clear();
            if (HostedContent is not null)
                _hostSlot.Children.Add(HostedContent);

            _spinner.IsActive = IsLoading;
            _spinner.Visibility = IsLoading ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
