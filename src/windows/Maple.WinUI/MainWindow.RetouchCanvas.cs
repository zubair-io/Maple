using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly Canvas _repairCanvas = new() { Visibility = Visibility.Collapsed,
        HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top,
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
    private CancellationTokenSource? _repairMappingRequest;
    private object? _repairMappingPhoto;
    private int _repairOrientation;
    private RetouchState? _repairDraft;
    private RetouchSpot? _repairDragStart;
    private MaskPoint _repairAnchor;
    private bool _repairDraggingSource;
    private object? _repairGesturePhoto;

    private void BuildRetouchCanvas()
    {
        CropRotateHost.Children.Add(_repairCanvas);
        _repairCanvas.PointerPressed += RepairPointerPressed;
        _repairCanvas.PointerMoved += RepairPointerMoved;
        _repairCanvas.PointerReleased += RepairPointerReleased;
        _repairCanvas.PointerCanceled += (_, _) => CancelRepairGesture();
        _repairCanvas.PointerCaptureLost += (_, _) => CancelRepairGesture();
    }

    private async Task PrepareRepairCanvasAsync()
    {
        var photo = ViewModel.SelectedPhoto;
        if (photo == null || !CanEditRepairs) return;
        _repairMappingRequest?.Cancel();
        _repairMappingRequest?.Dispose();
        var owner = _repairMappingRequest = new CancellationTokenSource();
        try
        {
            var orientation = await _detailDecoder.ReadOrientationAsync(photo.EditPath, ViewModel.Adjustments.Clone(), owner.Token);
            if (_closing || owner.IsCancellationRequested || photo != ViewModel.SelectedPhoto || _activeGroup != "Heal") return;
            _repairOrientation = (int)orientation;
            _repairMappingPhoto = photo;
            SyncRetouchPanel();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (!owner.IsCancellationRequested && !_closing) _repairStatus.Text = $"Repair canvas is unavailable: {error.Message}";
        }
    }

    private RepairCanvasMap? RepairMap => ReferenceEquals(_repairMappingPhoto, ViewModel.SelectedPhoto)
        && _repairOrientation is >= 1 and <= 8 && ContentFitRect() is { } fit && fit.H > 0
        ? new(_repairOrientation, fit.W / fit.H, ViewModel.Adjustments) : null;

    private void ExitRetouchCanvas()
    {
        CancelRepairGesture();
        _repairMappingRequest?.Cancel();
        _repairCanvas.Visibility = Visibility.Collapsed;
    }

    private void CancelRepairGesture()
    {
        _repairDraft = null;
        _repairDragStart = null;
        _repairGesturePhoto = null;
        _repairCanvas.ReleasePointerCaptures();
        UpdateRepairCanvas();
    }

    private void UpdateRepairCanvas()
    {
        if (_activeGroup != "Heal" || _mode != ShellMode.Edit || ContentFitRect() is not { } fit)
        { _repairCanvas.Visibility = Visibility.Collapsed; return; }
        if (_repairGesturePhoto != null && !ReferenceEquals(_repairGesturePhoto, ViewModel.SelectedPhoto))
        { _repairDraft = null; _repairDragStart = null; _repairGesturePhoto = null; }
        _repairCanvas.Margin = new Thickness(fit.X, fit.Y, 0, 0);
        _repairCanvas.Width = fit.W;
        _repairCanvas.Height = fit.H;
        _repairCanvas.Children.Clear();
        var map = RepairMap;
        _repairCanvas.Visibility = map == null ? Visibility.Collapsed : Visibility.Visible;
        _repairCanvas.IsHitTestVisible = CanEditRepairs && map != null;
        if (map == null) return;
        var state = _repairDraft ?? ViewModel.Adjustments.Retouch;
        for (var i = 0; i < state.Spots.Count; i++)
        {
            var spot = state.Spots[i].Spot;
            DrawRepairDisc(map, new(spot.X, spot.Y), spot.Radius, i == _repairSelection);
            if (i != _repairSelection) continue;
            DrawRepairDisc(map, new(spot.SourceX, spot.SourceY), spot.Radius, true);
            if (map.ToDisplay(new(spot.X, spot.Y)) is { } dest && map.ToDisplay(new(spot.SourceX, spot.SourceY)) is { } source)
                _repairCanvas.Children.Add(new Line { X1 = dest.X * fit.W, Y1 = dest.Y * fit.H,
                    X2 = source.X * fit.W, Y2 = source.Y * fit.H, StrokeThickness = 1,
                    Stroke = (Brush)Application.Current.Resources["MapleTextMain"], IsHitTestVisible = false });
        }
    }

    private void DrawRepairDisc(RepairCanvasMap map, MaskPoint center, double radius, bool selected)
    {
        var path = new Polyline { StrokeThickness = selected ? 2 : 1,
            Stroke = (Brush)Application.Current.Resources[selected ? "MaplePrimary" : "MapleTextMain"], IsHitTestVisible = false };
        for (var i = 0; i <= 48; i++)
        {
            var angle = i * Math.PI / 24;
            if (map.ToDisplay(new(center.X + radius * Math.Cos(angle), center.Y + radius * map.FrameAspect * Math.Sin(angle))) is not { } p) return;
            path.Points.Add(new Point(p.X * _repairCanvas.Width, p.Y * _repairCanvas.Height));
        }
        _repairCanvas.Children.Add(path);
    }

    private MaskPoint? RepairPoint(PointerRoutedEventArgs e)
    {
        var local = e.GetCurrentPoint(_repairCanvas).Position;
        if (_repairCanvas.Width <= 0 || _repairCanvas.Height <= 0) return null;
        var point = RepairMap?.ToFrame(new(local.X / _repairCanvas.Width, local.Y / _repairCanvas.Height));
        return point is { X: >= 0 and <= 1, Y: >= 0 and <= 1 } ? point : null;
    }

    private void RepairPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        if (!CanEditRepairs || !e.GetCurrentPoint(_repairCanvas).Properties.IsLeftButtonPressed
            || RepairPoint(e) is not { } point || RepairMap is not { } map) return;
        // Leave numeric editing before canvas gestures so Delete/Undo target the repair.
        ViewerScroll.Focus(FocusState.Pointer);
        _repairDraft = ViewModel.Adjustments.Retouch;
        _repairGesturePhoto = ViewModel.SelectedPhoto;
        _repairAnchor = point;
        _repairDraggingSource = false;
        var mouse = e.GetCurrentPoint(_repairCanvas).Position;
        bool Hit(double x, double y)
        {
            if (map.ToDisplay(new(x, y)) is not { } p) return false;
            return Math.Pow(p.X * _repairCanvas.Width - mouse.X, 2) + Math.Pow(p.Y * _repairCanvas.Height - mouse.Y, 2)
                <= Math.Pow(14 / ViewerScroll.ZoomFactor, 2);
        }
        var selected = SelectedRepair;
        if (selected != null && Hit(selected.SourceX, selected.SourceY)) _repairDraggingSource = true;
        else
        {
            _repairSelection = -1;
            for (var i = _repairDraft.Spots.Count - 1; i >= 0; i--)
                if (Hit(_repairDraft.Spots[i].Spot.X, _repairDraft.Spots[i].Spot.Y)) { _repairSelection = i; break; }
            if (_repairSelection < 0)
            {
                _repairDraft = XmpRetouch.Add(_repairDraft, new(selected?.Kind ?? RetouchKind.Heal, point.X, point.Y,
                    Math.Clamp(point.X + .08, 0, 1), point.Y,
                    AuthoredRepairValue(selected?.Radius, .02, .001),
                    AuthoredRepairValue(selected?.Feather, .5), AuthoredRepairValue(selected?.Opacity, 1)));
                _repairSelection = _repairDraft.Spots.Count - 1;
                _repairDraggingSource = true;
                _repairAnchor = new(_repairDraft.Spots[_repairSelection].Spot.SourceX, point.Y);
            }
        }
        _repairDragStart = _repairDraft.Spots[_repairSelection].Spot;
        _repairCanvas.CapturePointer(e.Pointer);
        UpdateRepairCanvas();
        e.Handled = true;
    }

    // Imported XML remains unchanged; only defaults for a newly authored spot are bounded.
    private static double AuthoredRepairValue(double? value, double fallback, double minimum = 0)
        => value is { } number && double.IsFinite(number) ? Math.Clamp(number, minimum, 1) : fallback;

    private void RepairPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_repairDraft == null || _repairDragStart is not { } start || RepairPoint(e) is not { } point) return;
        RetouchSpot moved;
        if (_repairDraggingSource) moved = start with { SourceX = point.X, SourceY = point.Y };
        else
        {
            var dx = Math.Clamp(point.X - _repairAnchor.X, -Math.Min(start.X, start.SourceX), 1 - Math.Max(start.X, start.SourceX));
            var dy = Math.Clamp(point.Y - _repairAnchor.Y, -Math.Min(start.Y, start.SourceY), 1 - Math.Max(start.Y, start.SourceY));
            moved = start with { X = start.X + dx, Y = start.Y + dy, SourceX = start.SourceX + dx, SourceY = start.SourceY + dy };
        }
        try { _repairDraft = XmpRetouch.Replace(_repairDraft, _repairSelection, moved); }
        catch (ArgumentOutOfRangeException) { CancelRepairGesture(); return; }
        UpdateRepairCanvas();
        e.Handled = true;
    }

    private void RepairPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        var draft = _repairDraft;
        var photo = _repairGesturePhoto;
        _repairDraft = null; _repairDragStart = null; _repairGesturePhoto = null;
        _repairCanvas.ReleasePointerCapture(e.Pointer);
        if (draft != null && ReferenceEquals(photo, ViewModel.SelectedPhoto) && CanEditRepairs) ApplyRepairs(draft);
        SyncRetouchPanel();
        e.Handled = true;
    }
}
