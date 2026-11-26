using System;
using System.Linq;
using Maple.WinUI.Services.Pano;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace Maple.WinUI.Views;

/// <summary>The layer over the stitch dialog's preview image where seam
/// regions are drawn and shown (#5992). Its surface is sized to the
/// uncropped preview canvas inside the same box the image is fitted to, so
/// a pointer position maps straight to reference preview pixels. UI-thread
/// only.</summary>
internal sealed class PanoSeamOverlay
{
    private readonly PanoSeamAuthoring _authoring;
    private uint? _pointer;
    private (double X, double Y) _start;
    private (double X, double Y) _end;

    public PanoSeamOverlay(PanoSeamAuthoring authoring)
    {
        _authoring = authoring;
        Root.Children.Add(Surface);
        AutomationProperties.SetHelpText(Surface,
            "Drag to add a rectangle, or use the labeled coordinate fields below.");
        Root.SizeChanged += (_, _) => Render();
        Surface.PointerPressed += OnPressed;
        Surface.PointerMoved += OnMoved;
        Surface.PointerReleased += OnReleased;
        Surface.PointerCanceled += (_, _) => CancelDrag();
        Surface.PointerCaptureLost += (_, _) => CancelDrag();
        authoring.Changed += Render;
        Render();
    }

    public event Action<PanoSeamRect>? Drawn;

    public Grid Root { get; } = new();

    public Canvas Surface { get; } = new()
    {
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
        ManipulationMode = ManipulationModes.None,
    };

    internal bool BeginDrag(Point position)
    {
        if (_pointer is not null || !_authoring.CanAuthor || ToCanvas(position) is not { } start)
            return false;
        _start = start;
        _end = start;
        return true;
    }

    internal void MoveDrag(Point position)
    {
        if (ToCanvas(position) is not { } end)
            return;
        _end = end;
        Render(dragging: true);
    }

    internal void EndDrag()
    {
        var drawn = _authoring.Canvas is { } canvas ? PanoSeamGeometry.DragRect(_start, _end, canvas) : null;
        Render();
        if (drawn is { } rect)
            Drawn?.Invoke(rect);
    }

    private void OnPressed(object sender, PointerRoutedEventArgs e)
    {
        var point = e.GetCurrentPoint(Surface);
        if (e.Pointer.PointerDeviceType == PointerDeviceType.Mouse && !point.Properties.IsLeftButtonPressed)
            return;
        if (!BeginDrag(point.Position) || !Surface.CapturePointer(e.Pointer))
            return;
        _pointer = e.Pointer.PointerId;
        e.Handled = true;
    }

    private void OnMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_pointer != e.Pointer.PointerId)
            return;
        MoveDrag(e.GetCurrentPoint(Surface).Position);
        e.Handled = true;
    }

    private void OnReleased(object sender, PointerRoutedEventArgs e)
    {
        if (_pointer != e.Pointer.PointerId)
            return;
        MoveDrag(e.GetCurrentPoint(Surface).Position);
        _pointer = null;
        Surface.ReleasePointerCapture(e.Pointer);
        e.Handled = true;
        EndDrag();
    }

    private void CancelDrag()
    {
        if (_pointer is null)
            return;
        _pointer = null;
        Render();
    }

    private (double X, double Y)? ToCanvas(Point position) =>
        _authoring.Canvas is { } canvas
            ? PanoSeamGeometry.ToCanvas(position.X, position.Y, Surface.Width, Surface.Height, canvas)
            : null;

    private void Render() => Render(dragging: false);

    private void Render(bool dragging)
    {
        var canvas = _authoring.Canvas;
        var (width, height) = canvas is { } size
            ? PanoSeamGeometry.Fit(size, Root.ActualWidth, Root.ActualHeight)
            : (0d, 0d);
        Surface.Width = width;
        Surface.Height = height;
        Surface.Visibility = width > 0 ? Visibility.Visible : Visibility.Collapsed;
        Surface.IsHitTestVisible = _authoring.CanAuthor;
        Surface.Children.Clear();
        if (canvas is not { } reference || width <= 0)
            return;
        AutomationProperties.SetName(Surface, PanoSeamText.CanvasName(reference));
        foreach (var (region, index) in _authoring.Regions.Select((region, index) => (region, index)))
            Draw(region.Rect, reference, region.Kind == PanoSeamKind.Exclude, region.Kind,
                PanoSeamText.Badge(index, region));
        if (dragging && _authoring.CanAuthor && PanoSeamGeometry.DragRect(_start, _end, reference) is { } draft)
            Draw(draft, reference, dashed: true, PanoSeamKind.Include, badge: null);
    }

    private void Draw(PanoSeamRect rect, PanoSeamCanvas canvas, bool dashed, PanoSeamKind kind, string? badge)
    {
        var (x, y, width, height) = PanoSeamGeometry.OnSurface(rect, canvas, Surface.Width, Surface.Height);
        var outline = new Rectangle
        {
            Width = Math.Max(1, width),
            Height = Math.Max(1, height),
            Stroke = Themed(kind == PanoSeamKind.Include ? "MaplePrimary" : "MapleWarn"),
            StrokeThickness = 2,
            IsHitTestVisible = false,
        };
        if (dashed)
            outline.StrokeDashArray = new DoubleCollection { 4, 3 };
        Place(outline, x, y);
        if (badge is null)
            return;
        var label = new TextBlock
        {
            Text = badge,
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            Foreground = Themed("MapleTextMain"),
        };
        AutomationProperties.SetAccessibilityView(label, AccessibilityView.Raw);
        Place(new Border
        {
            Background = Themed("MapleSurface"),
            Padding = new Thickness(3, 0, 3, 0),
            IsHitTestVisible = false,
            Child = label,
        }, x, y);
    }

    private void Place(FrameworkElement element, double x, double y)
    {
        Canvas.SetLeft(element, x);
        Canvas.SetTop(element, y);
        Surface.Children.Add(element);
    }

    private static Brush Themed(string key) => (Brush)Application.Current.Resources[key];
}
