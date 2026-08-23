using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI.Atoms
{
    /// <summary>QR placeholder size (unified-component-catalog.md §1.4
    /// Media, "QR Code" row: "Sizes").</summary>
    public enum MuiQrPlaceholderSize { Sm, Md, Lg }

    /// <summary>
    /// Maple.UI QR Code atom — currently shipped as a PLACEHOLDER, not a
    /// scannable QR code. unified-component-catalog.md §1.4's "QR Code" row
    /// calls for one ("Renders a payload as a QR image · Sizes · Quiet zone
    /// · Contrast requirement"), but no QR-capable dependency exists in
    /// Maple.WinUI.csproj (checked: CommunityToolkit.WinUI.UI.Controls
    /// 7.1.2 carries none), and this wave has no local Windows toolchain to
    /// compile-verify a newly added NuGet package's API surface against —
    /// guessing at one blind was judged worse than shipping a labeled
    /// placeholder. The real-QR need is filed as a follow-up on #3012.
    ///
    /// The block pattern is deterministic (same payload -> same pattern,
    /// via <see cref="MuiQrPlaceholderPattern"/>, WinUI-free and
    /// unit-tested) so it at least reads as payload-derived rather than
    /// static noise, and the quiet-zone margin + finder-square styling
    /// mimic a real QR code's proportions. It does not encode
    /// <see cref="Payload"/> and cannot be scanned.
    /// </summary>
    public sealed class MuiQrPlaceholder : ContentControl
    {
        public static readonly DependencyProperty PayloadProperty =
            DependencyProperty.Register(nameof(Payload), typeof(string), typeof(MuiQrPlaceholder),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiQrPlaceholder)d).Rebuild()));

        public static readonly DependencyProperty PlaceholderSizeProperty =
            DependencyProperty.Register(nameof(PlaceholderSize), typeof(MuiQrPlaceholderSize), typeof(MuiQrPlaceholder),
                new PropertyMetadata(MuiQrPlaceholderSize.Md, (d, _) => ((MuiQrPlaceholder)d).Rebuild()));

        public string Payload
        {
            get => (string)GetValue(PayloadProperty);
            set => SetValue(PayloadProperty, value);
        }

        public MuiQrPlaceholderSize PlaceholderSize
        {
            get => (MuiQrPlaceholderSize)GetValue(PlaceholderSizeProperty);
            set => SetValue(PlaceholderSizeProperty, value);
        }

        private const int GridSize = 21; // matches a real QR "Version 1" module count.

        private readonly Border _quietZone = new();
        private readonly Grid _grid = new();
        private readonly Rectangle[,] _cells = new Rectangle[GridSize, GridSize];

        public MuiQrPlaceholder()
        {
            // Star-sized (not the Grid default Auto): a Rectangle cell has
            // no intrinsic size of its own, so Auto rows/columns would
            // collapse to 0 — Star rows/columns instead divide the Grid's
            // explicit Width/Height (set in Rebuild) evenly, and Shape's
            // default Stretch alignment fills each cell.
            for (var i = 0; i < GridSize; i++)
            {
                _grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
                _grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            }
            for (var y = 0; y < GridSize; y++)
            {
                for (var x = 0; x < GridSize; x++)
                {
                    var cell = new Rectangle();
                    Grid.SetRow(cell, y);
                    Grid.SetColumn(cell, x);
                    _cells[y, x] = cell;
                    _grid.Children.Add(cell);
                }
            }

            _quietZone.Child = _grid;
            Content = _quietZone;
            IsTabStop = false;
            AutomationProperties.SetName(this, "QR code placeholder");

            Rebuild();
        }

        private static double EdgeFor(MuiQrPlaceholderSize size) => size switch
        {
            MuiQrPlaceholderSize.Sm => 96,
            MuiQrPlaceholderSize.Lg => 192,
            _ => 144,
        };

        private void Rebuild()
        {
            var edge = EdgeFor(PlaceholderSize);
            // Quiet zone: a real QR code's mandatory blank margin is 4
            // modules wide — approximated here as a fixed fraction of the
            // overall edge so it scales with PlaceholderSize.
            var quietZonePx = edge * (4.0 / GridSize);

            _quietZone.Width = edge;
            _quietZone.Height = edge;
            _quietZone.Padding = new Thickness(quietZonePx);
            _quietZone.CornerRadius = new CornerRadius(8);
            // High-contrast pairing per the catalog's "Contrast requirement"
            // — an unconditionally light quiet zone regardless of app theme,
            // since a real QR scanner needs true black-on-white contrast,
            // not this app's dark-surface token.
            _quietZone.Background = new SolidColorBrush(Microsoft.UI.Colors.White);
            _grid.Width = edge - quietZonePx * 2;
            _grid.Height = edge - quietZonePx * 2;

            var pattern = MuiQrPlaceholderPattern.Generate(Payload ?? string.Empty, GridSize);
            var fill = new SolidColorBrush(Microsoft.UI.Colors.Black);
            for (var y = 0; y < GridSize; y++)
            {
                for (var x = 0; x < GridSize; x++)
                    _cells[y, x].Fill = pattern[y, x] ? fill : null;
            }
        }
    }
}
