using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CanvasTouchTrackerTests
{
    [Fact]
    public void One_finger_reports_its_translation_from_the_press_and_ends_the_drag_on_lift()
    {
        var tracker = new CanvasTouchTracker();
        Assert.Equal(new CanvasTouchUpdate { DragBegan = true }, tracker.Press(1, 100, 100));
        var moved = tracker.Move(1, 130, 90);
        Assert.Equal((30.0, -10.0), moved.DragTranslation!.Value);
        Assert.Null(moved.Pinch);
        var lifted = tracker.Release(1);
        Assert.True(lifted.DragEnded);
        Assert.Null(lifted.PinchEndedMagnification);
        Assert.Equal(0, tracker.Count);
    }

    [Fact]
    public void Second_finger_starts_a_pinch_with_a_capture_frame_and_cumulative_magnification()
    {
        var tracker = new CanvasTouchTracker();
        tracker.Press(1, 100, 100);
        var started = tracker.Press(2, 200, 100);
        Assert.Equal((1.0, 150.0, 100.0), started.Pinch!.Value);
        Assert.True(tracker.IsPinching);

        var spread = tracker.Move(2, 300, 100);
        Assert.Equal((2.0, 200.0, 100.0), spread.Pinch!.Value);
        Assert.Null(spread.DragTranslation);

        var primaryMoved = tracker.Move(1, 50, 100);
        Assert.Equal((2.5, 175.0, 100.0), primaryMoved.Pinch!.Value);
        Assert.Equal((-50.0, 0.0), primaryMoved.DragTranslation!.Value);
    }

    [Fact]
    public void Lifting_the_first_finger_ends_the_pinch_and_keeps_the_drag_translation_continuous()
    {
        var tracker = new CanvasTouchTracker();
        tracker.Press(1, 100, 100);
        tracker.Press(2, 200, 100);
        tracker.Move(1, 90, 100);
        tracker.Move(2, 220, 100);

        var lifted = tracker.Release(1);
        Assert.Equal(1.3, lifted.PinchEndedMagnification!.Value, 10);
        Assert.False(lifted.DragEnded);
        Assert.False(tracker.IsPinching);

        var carried = tracker.Move(2, 230, 110);
        Assert.Equal((0.0, 10.0), carried.DragTranslation!.Value);

        var done = tracker.Release(2);
        Assert.True(done.DragEnded);
        Assert.Null(done.PinchEndedMagnification);
    }

    [Fact]
    public void A_third_finger_does_not_join_the_pinch_and_a_pinch_finger_lifting_restarts_it()
    {
        var tracker = new CanvasTouchTracker();
        tracker.Press(1, 0, 0);
        tracker.Press(2, 100, 0);
        Assert.Equal(default(CanvasTouchUpdate), tracker.Press(3, 0, 100));
        Assert.Null(tracker.Move(3, 0, 300).Pinch);

        var restarted = tracker.Release(2);
        Assert.Equal(1.0, restarted.PinchEndedMagnification!.Value);
        Assert.Equal((1.0, 0.0, 150.0), restarted.Pinch!.Value);
        Assert.True(tracker.IsPinching);
    }

    [Fact]
    public void Unknown_and_repeated_contacts_change_nothing()
    {
        var tracker = new CanvasTouchTracker();
        tracker.Press(1, 10, 10);
        Assert.Equal(default(CanvasTouchUpdate), tracker.Press(1, 50, 50));
        Assert.Equal(1, tracker.Count);
        Assert.Equal(default(CanvasTouchUpdate), tracker.Move(9, 0, 0));
        Assert.Equal(default(CanvasTouchUpdate), tracker.Release(9));
        Assert.Equal((5.0, 5.0), tracker.Move(1, 15, 15).DragTranslation!.Value);
    }

    [Fact]
    public void A_pinch_that_starts_after_a_drag_reports_the_drag_so_far_as_the_model_s_baseline()
    {
        var tracker = new CanvasTouchTracker();
        tracker.Press(1, 100, 100);
        tracker.Move(1, 150, 100);
        var started = tracker.Press(2, 300, 100);
        Assert.Equal((50.0, 0.0), started.DragTranslation!.Value);
        Assert.Equal((1.0, 225.0, 100.0), started.Pinch!.Value);
        tracker.Move(2, 400, 100);
        tracker.Release(2);
        Assert.Equal((51.0, 0.0), tracker.Move(1, 151, 100).DragTranslation!.Value);
    }

    [Fact]
    public void Reset_forgets_a_pinch_in_progress()
    {
        var tracker = new CanvasTouchTracker();
        tracker.Press(1, 0, 0);
        tracker.Press(2, 100, 0);
        tracker.Reset();
        Assert.False(tracker.IsPinching);
        Assert.Equal(0, tracker.Count);
        Assert.Equal(default(CanvasTouchUpdate), tracker.Move(2, 300, 0));
        Assert.Equal(new CanvasTouchUpdate { DragBegan = true }, tracker.Press(3, 5, 5));
    }
}
