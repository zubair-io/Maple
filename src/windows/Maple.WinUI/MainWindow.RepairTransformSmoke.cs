using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    // Exercise the actual WinUI visual transforms, including the zoom/pan layer,
    // rather than treating the pure projective-map tests as canvas qualification.
    private async Task VerifyRepairTransformsAsync()
    {
        var model = ViewModel.Adjustments;
        var crop = model.Crop;
        var horizontal = model.PerspectiveHorizontal;
        var vertical = model.PerspectiveVertical;
        var rotate = model.PerspectiveRotate;
        try
        {
            foreach (var angle in new[] { 0d, 17d, -29d })
            {
                model.Crop = new CropState(.15, .2, .85, .8, angle);
                model.PerspectiveHorizontal = 23;
                model.PerspectiveVertical = -19;
                model.PerspectiveRotate = 11;
                UpdateCropDisplay();
                UpdateRepairCanvas();
                SyncCanvasZoom(refreshDetail: false);
                _canvasZoom.ResetToFit();
                for (var step = 0; step < 3; step++) _canvasZoom.StepIn();
                // The model caps zoom at 8 real pixels per image pixel, so an
                // image whose fit is already past that (the 64px lifecycle
                // fixture) cannot zoom in; exercise the zoomed-out scale then.
                if (_canvasZoom.View.ScaleToFit <= 1)
                {
                    _canvasZoom.ResetToFit();
                    for (var step = 0; step < 3; step++) _canvasZoom.StepOut();
                }
                _canvasZoom.PanBy(-40, -30);
                ApplyCanvasZoom();
                var view = _canvasZoom.View;
                if (view.ScaleToFit == 1)
                    throw new InvalidOperationException("Repair zoom diagnostic did not leave fit");
                if (!TransformHolds(ZoomPanTransform.ScaleX, view.ScaleToFit) || !TransformHolds(ZoomPanTransform.ScaleY, view.ScaleToFit)
                    || !TransformHolds(ZoomPanTransform.TranslateX, view.PanX) || !TransformHolds(ZoomPanTransform.TranslateY, view.PanY))
                    throw new InvalidOperationException("Repair zoom diagnostic was not applied to the viewer transform");
                await Task.Yield();
                ZoomHost.UpdateLayout();
                var fit = ContentFitRect() ?? throw new InvalidOperationException("Repair image footprint missing");
                var map = RepairMap ?? throw new InvalidOperationException("Repair coordinate map missing");
                var a = new MaskPoint(.45, .46);
                var b = new MaskPoint(.53, .55);
                var da = map.ToDisplay(a)!.Value;
                var db = map.ToDisplay(b)!.Value;
                var visual = _repairCanvas.TransformToVisual(ViewerViewport);
                var screenA = visual.TransformPoint(new Point(da.X * fit.W, da.Y * fit.H));
                var screenB = visual.TransformPoint(new Point(db.X * fit.W, db.Y * fit.H));
                var dx = (db.X - da.X) * fit.W;
                var dy = (db.Y - da.Y) * fit.H;
                var radians = angle * Math.PI / 180;
                var scale = Math.Min(ZoomHost.ActualWidth / (.6 * fit.W), ZoomHost.ActualHeight / (.7 * fit.H)) * ZoomPanTransform.ScaleX;
                Near(screenB.X - screenA.X, (dx * Math.Cos(radians) - dy * Math.Sin(radians)) * scale, .1);
                Near(screenB.Y - screenA.Y, (dx * Math.Sin(radians) + dy * Math.Cos(radians)) * scale, .1);
                var inverse = ViewerViewport.TransformToVisual(_repairCanvas).TransformPoint(screenB);
                var recovered = map.ToFrame(new(inverse.X / fit.W, inverse.Y / fit.H))!.Value;
                Near(recovered.X, b.X, 1e-5);
                Near(recovered.Y, b.Y, 1e-5);
            }
        }
        finally
        {
            model.Crop = crop;
            model.PerspectiveHorizontal = horizontal;
            model.PerspectiveVertical = vertical;
            model.PerspectiveRotate = rotate;
            ResetZoom();
            UpdateCropDisplay();
            UpdateRepairCanvas();
        }

        static void Near(double actual, double expected, double tolerance)
        {
            if (!double.IsFinite(actual) || Math.Abs(actual - expected) > tolerance)
                throw new InvalidOperationException($"Repair visual transform mismatch: {actual} versus {expected}");
        }
    }
}
