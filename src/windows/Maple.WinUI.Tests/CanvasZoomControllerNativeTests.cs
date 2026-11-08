using System.Runtime.CompilerServices;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

/// <summary>
/// The viewer's zoom controller against the real raw_ffi zoom model (#5714):
/// a 4000×2000 image in a 1000×800-point viewport at display scale 1, so fit
/// is 0.25 (width-bound, 1000×500 on screen) and fill is 0.4. Runs when
/// MAPLE_RAW_FFI_DLL points at a raw-ffi build, skip-passes otherwise.
/// </summary>
public sealed class CanvasZoomControllerNativeTests(ITestOutputHelper output)
{
    private const double Fit = 0.25;
    private const double Fill = 0.4;

    private bool Armed()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: the shared zoom model requires MAPLE_RAW_FFI_DLL.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        return true;
    }

    private static CanvasZoomController Controller()
    {
        var zoom = new CanvasZoomController();
        zoom.UpdateGeometry(1000, 800, 4000, 2000, 1);
        return zoom;
    }

    [Fact]
    public void Starts_at_fit_where_nothing_pans_and_a_plain_wheel_is_not_the_canvas_s()
    {
        if (!Armed()) return;
        var zoom = Controller();
        Assert.True(zoom.IsFit);
        Assert.Equal(new CanvasZoomView(1, 0, 0), zoom.View);
        Assert.Equal(Fit, zoom.EffectiveScale, 12);
        Assert.False(zoom.CanPan);
        Assert.False(zoom.DragChanged(40, 40));
        Assert.False(zoom.Wheel(-120, false, false, false, 500, 400));
        Assert.False(zoom.Wheel(120, true, true, false, 500, 400));
    }

    [Fact]
    public void Steps_go_below_fit_to_half_fit_and_stop_once_at_fit_on_the_way_back()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.StepIn();
        Assert.Equal(1.25, zoom.View.ScaleToFit, 12);
        zoom.ResetToFit();
        zoom.StepOut();
        Assert.Equal(0.8, zoom.View.ScaleToFit, 12);
        for (var i = 0; i < 10; i++) zoom.StepOut();
        Assert.Equal(0.5, zoom.View.ScaleToFit, 12);
        Assert.False(zoom.CanPan);
        for (var i = 0; i < 10 && !zoom.IsFit; i++) zoom.StepIn();
        Assert.True(zoom.IsFit);
    }

    [Fact]
    public void Ctrl_wheel_keeps_the_image_point_under_the_cursor()
    {
        if (!Armed()) return;
        var zoom = Controller();
        Assert.True(zoom.Wheel(120, false, true, false, 750, 400));
        var k = Math.Pow(2, CanvasZoomController.ZoomUnitsPerDetent * 0.015);
        Assert.Equal(k, zoom.View.ScaleToFit, 12);
        Assert.Equal(250 * (1 - k), zoom.View.PanX, 9);
        Assert.Equal(0, zoom.View.PanY, 12);
        Assert.True(zoom.Wheel(-120, false, true, false, 750, 400));
        Assert.True(zoom.IsFit);
    }

    [Fact]
    public void Double_tap_toggles_fit_and_100_percent_anchored_at_the_tap()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.DoubleTap(750, 400);
        Assert.Equal(1, zoom.EffectiveScale, 12);
        Assert.Equal(RawFfi.MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE, zoom.CurrentStop);
        // The tapped image point (250 fit-points right of centre) stays put.
        Assert.Equal(250 - 250 / Fit, zoom.View.PanX, 9);
        zoom.DoubleTap(100, 100);
        Assert.True(zoom.IsFit);
    }

    [Fact]
    public void Actual_size_is_centred_and_shows_the_middle_viewport_of_source_pixels()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.ZoomToActualSize();
        Assert.Equal(new CanvasZoomView(1 / Fit, 0, 0), zoom.View);
        var visible = zoom.VisibleSourceRect;
        Assert.Equal((1500.0, 600.0, 1000.0, 800.0), (visible.x, visible.y, visible.width, visible.height));
    }

    [Fact]
    public void Wheel_and_drag_pan_while_the_image_overflows_and_stop_at_its_edges()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.ZoomToActualSize();
        Assert.True(zoom.CanPan);
        Assert.True(zoom.Wheel(-120, false, false, false, 0, 0));
        Assert.Equal(-48, zoom.View.PanY, 12);
        Assert.True(zoom.Wheel(-120, false, false, true, 0, 0));
        Assert.Equal(-48, zoom.View.PanX, 12);
        Assert.True(zoom.Wheel(120, true, false, false, 0, 0));
        Assert.Equal(-96, zoom.View.PanX, 12);
        Assert.True(zoom.Wheel(-120 * 100, false, false, false, 0, 0));
        Assert.Equal(-600, zoom.View.PanY, 12);

        zoom.ZoomToActualSize();
        Assert.True(zoom.DragChanged(100, 50));
        Assert.Equal((100.0, 50.0), (zoom.View.PanX, zoom.View.PanY));
        Assert.True(zoom.DragEnded());
        Assert.True(zoom.DragChanged(5000, 0));
        Assert.Equal(1500, zoom.View.PanX, 12);
    }

    [Fact]
    public void A_pinch_released_inside_the_fill_band_settles_on_fill_which_follows_a_resize()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.PinchChanged(1, 500, 400);
        Assert.True(zoom.IsPinching);
        Assert.True(zoom.IsFit);
        zoom.PinchChanged(Fill / Fit * 1.02, 500, 400);
        zoom.PinchEnded(Fill / Fit * 1.02);
        Assert.False(zoom.IsPinching);
        Assert.Equal(RawFfi.MAPLE_CANVAS_ZOOM_STOP_FILL, zoom.CurrentStop);
        Assert.Equal(Fill / Fit, zoom.View.ScaleToFit, 12);

        zoom.UpdateGeometry(800, 800, 4000, 2000, 1);
        Assert.Equal(RawFfi.MAPLE_CANVAS_ZOOM_STOP_FILL, zoom.CurrentStop);
        Assert.Equal(2, zoom.View.ScaleToFit, 12);
    }

    [Fact]
    public void A_pinch_inside_the_fit_band_returns_to_fit()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.PinchChanged(1, 300, 200);
        zoom.PinchChanged(1.03, 300, 200);
        zoom.PinchEnded(1.03);
        Assert.True(zoom.IsFit);
        Assert.Equal(new CanvasZoomView(1, 0, 0), zoom.View);
    }

    [Fact]
    public void Reading_the_source_size_keeps_a_free_zoom_s_on_screen_size()
    {
        if (!Armed()) return;
        var zoom = new CanvasZoomController();
        zoom.UpdateGeometry(1000, 800, 2000, 1000, 1);
        zoom.StepIn();
        zoom.StepIn();
        var before = zoom.View;
        var previewScale = zoom.EffectiveScale;

        zoom.UpdateGeometry(1000, 800, 4000, 2000, 1);
        Assert.Equal(before.ScaleToFit, zoom.View.ScaleToFit, 12);
        Assert.Equal(previewScale / 2, zoom.EffectiveScale, 12);

        zoom.UpdateGeometry(1000, 800, 4000, 2000, 1);
        Assert.Equal(before.ScaleToFit, zoom.View.ScaleToFit, 12);
    }

    [Fact]
    public void A_free_scale_holds_its_pixel_scale_across_a_resize_and_the_pan_re_clamps()
    {
        if (!Armed()) return;
        var zoom = Controller();
        zoom.ZoomToActualSize();
        zoom.PanBy(0, -600);
        zoom.UpdateGeometry(1000, 1600, 4000, 2000, 1);
        Assert.Equal(1, zoom.EffectiveScale, 12);
        Assert.Equal(-200, zoom.View.PanY, 12);
    }

    [Fact]
    public void Zoom_input_before_the_first_frame_is_ignored()
    {
        if (!Armed()) return;
        var zoom = new CanvasZoomController();
        Assert.False(zoom.HasGeometry);
        Assert.False(zoom.Wheel(120, false, true, false, 10, 10));
        zoom.StepIn();
        zoom.ZoomToFill();
        zoom.DoubleTap(10, 10);
        zoom.PinchChanged(1, 10, 10);
        zoom.PinchChanged(2, 10, 10);
        Assert.True(zoom.IsFit);
        Assert.False(zoom.IsPinching);
    }

    [Fact]
    public void A_pinch_in_progress_when_the_source_size_lands_keeps_its_on_screen_scale()
    {
        if (!Armed()) return;
        var zoom = new CanvasZoomController();
        zoom.UpdateGeometry(1000, 800, 2000, 1000, 1);
        zoom.PinchChanged(1, 500, 400);
        zoom.PinchChanged(2, 500, 400);
        var before = zoom.View.ScaleToFit;

        zoom.UpdateGeometry(1000, 800, 4000, 2000, 1);
        zoom.PinchChanged(2, 500, 400);
        Assert.Equal(before, zoom.View.ScaleToFit, 9);
        Assert.Equal(2 * Fit, zoom.EffectiveScale, 9);
    }

    [Fact]
    public void One_stand_in_preview_replacing_another_keeps_a_free_zoom_s_on_screen_size()
    {
        if (!Armed()) return;
        var zoom = new CanvasZoomController();
        zoom.UpdateGeometry(1000, 800, 512, 256, 1);
        zoom.StepIn();
        Assert.Equal(1.25, zoom.View.ScaleToFit, 12);

        zoom.UpdateGeometry(1000, 800, 2048, 1024, 1);
        Assert.Equal(1.25, zoom.View.ScaleToFit, 12);
        zoom.PanBy(0, 0);
        Assert.Equal(1.25, zoom.View.ScaleToFit, 12);

        zoom.UpdateGeometry(1000, 800, 4000, 2000, 1);
        Assert.Equal(1.25, zoom.View.ScaleToFit, 12);
        Assert.Equal(1.25 * Fit, zoom.EffectiveScale, 12);
    }
}
