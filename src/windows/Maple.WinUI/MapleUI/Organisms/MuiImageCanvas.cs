using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Image Canvas organism (unified-component-catalog.md
    /// §4.5, "Image Canvas" row: "Zoom, pan, before/after, render", built
    /// from Canvas Surface, Preview Image, Crop Overlay) — a
    /// <see cref="MuiCanvasSurface"/> hosting a <see cref="MuiPreviewImage"/>
    /// under a Scale/Translate transform pair. Mouse-wheel zoom and
    /// click-drag pan are <see cref="MuiImageCanvasMath"/>, unit tested
    /// standalone; this control only wires <c>PointerWheelChanged</c>/
    /// <c>PointerMoved</c> to it and applies the result to the
    /// transforms. <see cref="ShowBefore"/> swaps in
    /// <see cref="BeforeSource"/> in place of <see cref="Source"/> — the
    /// before/after toggle. <see cref="CropMode"/> overlays a live
    /// <see cref="MuiCropOverlay"/> bound to <see cref="CropRect"/>.
    /// </summary>
    public sealed class MuiImageCanvas : ContentControl
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiImageCanvas),
                new PropertyMetadata(null, (d, _) => ((MuiImageCanvas)d).Rebuild()));

        public static readonly DependencyProperty BeforeSourceProperty =
            DependencyProperty.Register(nameof(BeforeSource), typeof(ImageSource), typeof(MuiImageCanvas),
                new PropertyMetadata(null, (d, _) => ((MuiImageCanvas)d).Rebuild()));

        public static readonly DependencyProperty ShowBeforeProperty =
            DependencyProperty.Register(nameof(ShowBefore), typeof(bool), typeof(MuiImageCanvas),
                new PropertyMetadata(false, (d, _) => ((MuiImageCanvas)d).Rebuild()));

        public static readonly DependencyProperty IsLoadingProperty =
            DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(MuiImageCanvas),
                new PropertyMetadata(false, (d, e) => ((MuiImageCanvas)d)._surface.IsLoading = (bool)e.NewValue));

        public static readonly DependencyProperty ImageWidthProperty =
            DependencyProperty.Register(nameof(ImageWidth), typeof(double), typeof(MuiImageCanvas),
                new PropertyMetadata(0.0, (d, e) => ((MuiImageCanvas)d).OnImageWidthChanged((double)e.NewValue)));

        public static readonly DependencyProperty ImageHeightProperty =
            DependencyProperty.Register(nameof(ImageHeight), typeof(double), typeof(MuiImageCanvas),
                new PropertyMetadata(0.0, (d, e) => ((MuiImageCanvas)d).OnImageHeightChanged((double)e.NewValue)));

        public static readonly DependencyProperty ZoomProperty =
            DependencyProperty.Register(nameof(Zoom), typeof(double), typeof(MuiImageCanvas),
                new PropertyMetadata(1.0, (d, e) => ((MuiImageCanvas)d).ApplyTransform()));

        public static readonly DependencyProperty CropModeProperty =
            DependencyProperty.Register(nameof(CropMode), typeof(bool), typeof(MuiImageCanvas),
                new PropertyMetadata(false, (d, _) => ((MuiImageCanvas)d).Rebuild()));

        public static readonly DependencyProperty CropRectProperty =
            DependencyProperty.Register(nameof(CropRect), typeof(MuiCropRect), typeof(MuiImageCanvas),
                new PropertyMetadata(default(MuiCropRect), (d, e) => ((MuiImageCanvas)d)._cropOverlay.Rect = (MuiCropRect)e.NewValue));

        public ImageSource? Source { get => (ImageSource?)GetValue(SourceProperty); set => SetValue(SourceProperty, value); }
        public ImageSource? BeforeSource { get => (ImageSource?)GetValue(BeforeSourceProperty); set => SetValue(BeforeSourceProperty, value); }
        public bool ShowBefore { get => (bool)GetValue(ShowBeforeProperty); set => SetValue(ShowBeforeProperty, value); }
        public bool IsLoading { get => (bool)GetValue(IsLoadingProperty); set => SetValue(IsLoadingProperty, value); }
        public double ImageWidth { get => (double)GetValue(ImageWidthProperty); set => SetValue(ImageWidthProperty, value); }
        public double ImageHeight { get => (double)GetValue(ImageHeightProperty); set => SetValue(ImageHeightProperty, value); }
        public double Zoom { get => (double)GetValue(ZoomProperty); set => SetValue(ZoomProperty, MuiImageCanvasMath.ClampZoom(value)); }
        public bool CropMode { get => (bool)GetValue(CropModeProperty); set => SetValue(CropModeProperty, value); }
        public MuiCropRect CropRect { get => (MuiCropRect)GetValue(CropRectProperty); set => SetValue(CropRectProperty, value); }

        public event EventHandler<double>? ZoomChanged;
        public event EventHandler<MuiCropRect>? CropRectChanged;

        private readonly Grid _root = new();
        private readonly MuiCanvasSurface _surface = new();
        private readonly Grid _imageHost = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiPreviewImage _image = new() { Fit = MuiImageFit.Uniform };
        private readonly ScaleTransform _scale = new();
        private readonly TranslateTransform _translate = new();
        private readonly MuiCropOverlay _cropOverlay = new() { Visibility = Visibility.Collapsed };

        private double _panX;
        private double _panY;
        private bool _dragging;
        private Point _dragOrigin;

        public MuiImageCanvas()
        {
            var group = new TransformGroup();
            group.Children.Add(_scale);
            group.Children.Add(_translate);
            _imageHost.RenderTransform = group;
            // The overlay shares the image's own transform group (rather
            // than sitting untransformed in the outer stage) so a crop
            // rect expressed in image-pixel space stays visually aligned
            // with the image through every zoom/pan change.
            _imageHost.Children.Add(_image);
            _imageHost.Children.Add(_cropOverlay);
            _surface.HostedContent = _imageHost;
            _root.Children.Add(_surface);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            PointerWheelChanged += OnPointerWheelChanged;
            PointerPressed += OnPointerPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += (_, _) => _dragging = false;
            _cropOverlay.RectChanged += (_, rect) => { CropRect = rect; CropRectChanged?.Invoke(this, rect); };

            Rebuild();
        }

        private void OnPointerWheelChanged(object sender, PointerRoutedEventArgs e)
        {
            if (CropMode) return;
            var delta = e.GetCurrentPoint(this).Properties.MouseWheelDelta;
            Zoom = MuiImageCanvasMath.ZoomForWheelDelta(Zoom, delta);
            ZoomChanged?.Invoke(this, Zoom);
        }

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (CropMode) return;
            _dragging = true;
            _dragOrigin = e.GetCurrentPoint(this).Position;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_dragging || CropMode) return;
            var pos = e.GetCurrentPoint(this).Position;
            var dx = pos.X - _dragOrigin.X;
            var dy = pos.Y - _dragOrigin.Y;
            _dragOrigin = pos;

            var (x, y) = MuiImageCanvasMath.ClampPan(
                _panX + dx, _panY + dy, ActualWidth, ActualHeight, ImageWidth, ImageHeight, Zoom);
            _panX = x;
            _panY = y;
            ApplyTransform();
        }

        private void OnImageWidthChanged(double width)
        {
            _image.Width = width;
            _cropOverlay.Bounds = new Size(width, _cropOverlay.Bounds.Height);
        }

        private void OnImageHeightChanged(double height)
        {
            _image.Height = height;
            _cropOverlay.Bounds = new Size(_cropOverlay.Bounds.Width, height);
        }

        private void ApplyTransform()
        {
            _scale.ScaleX = Zoom;
            _scale.ScaleY = Zoom;
            _translate.X = _panX;
            _translate.Y = _panY;
        }

        private void Rebuild()
        {
            _image.Source = ShowBefore ? BeforeSource : Source;
            _cropOverlay.Visibility = CropMode ? Visibility.Visible : Visibility.Collapsed;
            ApplyTransform();
        }
    }
}
