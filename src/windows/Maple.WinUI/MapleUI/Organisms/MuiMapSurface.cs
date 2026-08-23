using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace Maple.UI
{
    /// <summary>One geotagged asset on a Map Surface, in the surface's
    /// own screen-space coordinates.</summary>
    public sealed record MuiMapAsset(string Id, double X, double Y, ImageSource? Thumbnail = null, string? Label = null);

    /// <summary>
    /// Maple.UI Map Surface organism (unified-component-catalog.md §4.6,
    /// "Map Surface" row: "Clustered pins with density overlay", built
    /// from Map Annotation, Heatmap Layer, Empty State) — a plain token
    /// grid stands in for real map tiles (no map-provider integration
    /// this wave — YAGNI without a real caller), with drag-to-pan;
    /// <see cref="MuiMapAnnotation"/> pins are placed at cluster
    /// centroids computed live by <see cref="MuiMapClusterMath"/> as
    /// points/pan/zoom change, and an optional <see cref="MuiHeatmapLayer"/>
    /// overlays density. No assets at all shows a <see cref="MuiEmptyState"/>
    /// instead of an empty grid.
    /// </summary>
    public sealed class MuiMapSurface : ContentControl
    {
        private const double GridSpacing = 40;

        public static readonly DependencyProperty AssetsProperty =
            DependencyProperty.Register(nameof(Assets), typeof(IReadOnlyList<MuiMapAsset>), typeof(MuiMapSurface),
                new PropertyMetadata(null, (d, _) => ((MuiMapSurface)d).Rebuild()));

        public static readonly DependencyProperty ClusterRadiusProperty =
            DependencyProperty.Register(nameof(ClusterRadius), typeof(double), typeof(MuiMapSurface),
                new PropertyMetadata(48.0, (d, _) => ((MuiMapSurface)d).Rebuild()));

        public static readonly DependencyProperty ShowHeatmapProperty =
            DependencyProperty.Register(nameof(ShowHeatmap), typeof(bool), typeof(MuiMapSurface),
                new PropertyMetadata(false, (d, _) => ((MuiMapSurface)d).Rebuild()));

        public static readonly DependencyProperty DensityProperty =
            DependencyProperty.Register(nameof(Density), typeof(IReadOnlyList<IReadOnlyList<double>>), typeof(MuiMapSurface),
                new PropertyMetadata(null, (d, e) => ((MuiMapSurface)d)._heatmap.Density = (IReadOnlyList<IReadOnlyList<double>>?)e.NewValue));

        public IReadOnlyList<MuiMapAsset>? Assets
        {
            get => (IReadOnlyList<MuiMapAsset>?)GetValue(AssetsProperty);
            set => SetValue(AssetsProperty, value);
        }

        public double ClusterRadius { get => (double)GetValue(ClusterRadiusProperty); set => SetValue(ClusterRadiusProperty, value); }
        public bool ShowHeatmap { get => (bool)GetValue(ShowHeatmapProperty); set => SetValue(ShowHeatmapProperty, value); }

        public IReadOnlyList<IReadOnlyList<double>>? Density
        {
            get => (IReadOnlyList<IReadOnlyList<double>>?)GetValue(DensityProperty);
            set => SetValue(DensityProperty, value);
        }

        /// <summary>Fires with the member ids of a cluster when its pin
        /// is pressed — a single-member cluster is just one asset id.
        /// </summary>
        public event EventHandler<IReadOnlyList<string>>? ClusterActivated;

        private readonly Grid _root = new();
        private readonly Canvas _tokenGrid = new() { IsHitTestVisible = false };
        private readonly Canvas _pins = new();
        private readonly Grid _heatmapHost = new() { IsHitTestVisible = false, Visibility = Visibility.Collapsed };
        private readonly MuiHeatmapLayer _heatmap = new();
        private readonly MuiEmptyState _empty = new() { IconName = "map-pin", Title = "No geotagged photos" };

        private double _panX;
        private double _panY;
        private bool _dragging;
        private Point _dragOrigin;

        public MuiMapSurface()
        {
            _heatmapHost.Children.Add(_heatmap);
            _root.Children.Add(_tokenGrid);
            _root.Children.Add(_heatmapHost);
            _root.Children.Add(_pins);
            _root.Children.Add(_empty);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            SizeChanged += (_, _) => Rebuild();
            PointerPressed += (_, e) => { _dragging = true; _dragOrigin = e.GetCurrentPoint(this).Position; };
            PointerMoved += OnPointerMoved;
            PointerReleased += (_, _) => _dragging = false;

            Rebuild();
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_dragging) return;
            var pos = e.GetCurrentPoint(this).Position;
            _panX += pos.X - _dragOrigin.X;
            _panY += pos.Y - _dragOrigin.Y;
            _dragOrigin = pos;
            Rebuild();
        }

        private void Rebuild()
        {
            var assets = Assets ?? Array.Empty<MuiMapAsset>();
            _empty.Visibility = assets.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _tokenGrid.Visibility = assets.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
            _pins.Visibility = assets.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

            RebuildTokenGrid();

            _heatmapHost.Visibility = ShowHeatmap ? Visibility.Visible : Visibility.Collapsed;
            _heatmap.PlotWidth = Math.Max(0, ActualWidth);
            _heatmap.PlotHeight = Math.Max(0, ActualHeight);

            _pins.Children.Clear();
            var points = assets.Select(a => new MuiMapPoint(a.Id, a.X + _panX, a.Y + _panY)).ToList();
            var byId = assets.ToDictionary(a => a.Id);
            foreach (var cluster in MuiMapClusterMath.Cluster(points, ClusterRadius))
            {
                var representative = byId.TryGetValue(cluster.MemberIds[0], out var asset) ? asset : null;
                var pin = new MuiMapAnnotation
                {
                    Source = representative?.Thumbnail,
                    Label = cluster.Count > 1 ? null : representative?.Label,
                    Count = cluster.Count > 1 ? cluster.Count : null,
                };
                var memberIds = cluster.MemberIds;
                pin.Tapped += (_, _) => ClusterActivated?.Invoke(this, memberIds);
                Canvas.SetLeft(pin, cluster.X - pin.PinSize / 2);
                Canvas.SetTop(pin, cluster.Y - pin.PinSize);
                _pins.Children.Add(pin);
            }
        }

        private void RebuildTokenGrid()
        {
            _tokenGrid.Children.Clear();
            var width = Math.Max(0, ActualWidth);
            var height = Math.Max(0, ActualHeight);
            var offsetX = _panX % GridSpacing;
            var offsetY = _panY % GridSpacing;

            for (var x = offsetX; x < width; x += GridSpacing)
                _tokenGrid.Children.Add(new Line { X1 = x, Y1 = 0, X2 = x, Y2 = height, Stroke = TokenGridBrush(), StrokeThickness = 1 });
            for (var y = offsetY; y < height; y += GridSpacing)
                _tokenGrid.Children.Add(new Line { X1 = 0, Y1 = y, X2 = width, Y2 = y, Stroke = TokenGridBrush(), StrokeThickness = 1 });
        }

        private static Brush TokenGridBrush() => (Brush)Application.Current.Resources["MapleBorder"];
    }
}
