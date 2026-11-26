using System.Collections.Concurrent;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class LibraryHydrationTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(20);

    private static int[] Photos(int count) => Enumerable.Range(0, count).ToArray();

    private sealed class Recorder
    {
        public readonly List<int[]> Batches = new();
        public readonly List<string> Events = new();
        public readonly List<(int Item, Exception Error)> Failures = new();
        private int _applying;
        public int MaxApplyingAtOnce;

        public Task Apply(IReadOnlyList<(int Item, int Result)> batch)
        {
            var now = Interlocked.Increment(ref _applying);
            MaxApplyingAtOnce = Math.Max(MaxApplyingAtOnce, now);
            lock (Events) { Batches.Add(batch.Select(pair => pair.Item).ToArray()); Events.Add("batch"); }
            Interlocked.Decrement(ref _applying);
            return Task.CompletedTask;
        }

        public Task After() { lock (Events) Events.Add("after"); return Task.CompletedTask; }

        public void Fail(int item, Exception error) { lock (Failures) Failures.Add((item, error)); }
    }

    private static Task Run(int[] items, Recorder recorder, Func<int, CancellationToken, Task<int>> work,
        CancellationToken ct = default, Func<IReadOnlyList<(int Item, int Result)>, Task>? apply = null,
        int width = LibraryHydration.Width, int batchSize = LibraryHydration.BatchSize) =>
        LibraryHydration.RunAsync(items, width, batchSize, work, apply ?? recorder.Apply, recorder.After, recorder.Fail, ct);

    [Fact]
    public async Task Work_runs_three_at_a_time_never_more_and_really_in_parallel()
    {
        var inFlight = 0;
        var maxInFlight = 0;
        var threeAtOnce = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var recorder = new Recorder();

        await Run(Photos(60), recorder, async (item, ct) =>
        {
            var now = Interlocked.Increment(ref inFlight);
            lock (recorder) maxInFlight = Math.Max(maxInFlight, now);
            if (now >= 3) threeAtOnce.TrySetResult();
            await threeAtOnce.Task.WaitAsync(Patience, ct);
            await Task.Delay(3, ct);
            Interlocked.Decrement(ref inFlight);
            return item;
        });

        Assert.Equal(3, maxInFlight);
        Assert.Equal(3, LibraryHydration.Width);
        Assert.Equal(4, LibraryHydration.RenderGateWidth);
    }

    [Fact]
    public async Task Every_photo_is_applied_once_in_listing_order_in_bounded_batches_one_at_a_time()
    {
        var recorder = new Recorder();
        var random = new Random(7);
        var delays = Photos(200).Select(_ => random.Next(0, 6)).ToArray();

        await Run(Photos(200), recorder, async (item, ct) => { await Task.Delay(delays[item], ct); return item; });

        Assert.Equal(Photos(200), recorder.Batches.SelectMany(batch => batch).ToArray());
        Assert.All(recorder.Batches, batch => Assert.InRange(batch.Length, 1, LibraryHydration.BatchSize));
        Assert.Equal(1, recorder.MaxApplyingAtOnce);
    }

    [Fact]
    public async Task Photos_that_finish_while_the_ui_is_busy_are_applied_together()
    {
        var recorder = new Recorder();

        await Run(Photos(100), recorder, (item, ct) => Task.FromResult(item),
            apply: async batch => { await recorder.Apply(batch); await Task.Delay(40); });

        Assert.Equal(Photos(100), recorder.Batches.SelectMany(batch => batch).ToArray());
        Assert.Equal(LibraryHydration.BatchSize, recorder.Batches.Max(batch => batch.Length));
        Assert.True(recorder.Batches.Count < 100);
    }

    [Fact]
    public async Task A_slow_first_photo_holds_back_later_ones_without_stalling_the_run()
    {
        var recorder = new Recorder();
        var othersDone = 0;
        var allOthersDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var appliedBeforeFirstFinished = 0;
        var firstFinished = false;

        await Run(Photos(100), recorder, async (item, ct) =>
        {
            if (item == 0)
            {
                await allOthersDone.Task.WaitAsync(Patience, ct);
                firstFinished = true;
                return item;
            }
            if (Interlocked.Increment(ref othersDone) == 99) allOthersDone.TrySetResult();
            return item;
        }, apply: batch =>
        {
            if (!firstFinished) Interlocked.Increment(ref appliedBeforeFirstFinished);
            return recorder.Apply(batch);
        });

        Assert.Equal(0, appliedBeforeFirstFinished);
        Assert.Equal(Photos(100), recorder.Batches.SelectMany(batch => batch).ToArray());
    }

    [Fact]
    public async Task The_final_step_runs_exactly_once_after_the_last_batch()
    {
        var recorder = new Recorder();

        await Run(Photos(80), recorder, (item, ct) => Task.FromResult(item));

        Assert.Equal("after", recorder.Events[^1]);
        Assert.Equal(1, recorder.Events.Count(e => e == "after"));
        Assert.Equal(80, recorder.Batches.Sum(batch => batch.Length));
    }

    [Fact]
    public async Task With_nothing_to_apply_the_final_step_does_not_run()
    {
        var empty = new Recorder();
        await Run(Array.Empty<int>(), empty, (item, ct) => Task.FromResult(item));
        Assert.Empty(empty.Events);

        var allFail = new Recorder();
        await Run(Photos(5), allFail, (item, ct) => throw new InvalidOperationException("no"));
        Assert.Empty(allFail.Events);
        Assert.Equal(5, allFail.Failures.Count);
    }

    [Fact]
    public async Task One_failing_photo_is_reported_and_skipped_and_the_others_still_arrive()
    {
        var recorder = new Recorder();

        await Run(Photos(40), recorder, (item, ct) =>
            item == 7 ? throw new InvalidOperationException("boom 7") : Task.FromResult(item));

        Assert.Equal(Photos(40).Where(i => i != 7).ToArray(), recorder.Batches.SelectMany(batch => batch).ToArray());
        var failure = Assert.Single(recorder.Failures);
        Assert.Equal(7, failure.Item);
        Assert.Equal("boom 7", failure.Error.Message);
        Assert.Equal("after", recorder.Events[^1]);
    }

    [Fact]
    public async Task Cancelling_stops_the_run_and_nothing_is_applied_afterwards()
    {
        var recorder = new Recorder();
        using var cts = new CancellationTokenSource();
        var started = 0;

        var run = Run(Photos(500), recorder, async (item, ct) =>
        {
            if (Interlocked.Increment(ref started) == 30) cts.Cancel();
            await Task.Delay(2, ct);
            return item;
        }, cts.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        var appliedAtStop = recorder.Batches.Sum(batch => batch.Length);
        await Task.Delay(100);

        Assert.Equal(appliedAtStop, recorder.Batches.Sum(batch => batch.Length));
        Assert.DoesNotContain("after", recorder.Events);
        Assert.True(appliedAtStop < 500);
        Assert.Equal(recorder.Batches.SelectMany(batch => batch).ToArray(), Photos(appliedAtStop));
    }

    [Fact]
    public async Task A_run_cancelled_before_it_starts_applies_nothing()
    {
        var recorder = new Recorder();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Run(Photos(10), recorder, (item, ct) => Task.FromResult(item), new CancellationToken(canceled: true)));

        Assert.Empty(recorder.Events);
    }

    [Fact]
    public async Task A_failing_ui_step_surfaces_its_error_and_stops_the_work()
    {
        var recorder = new Recorder();
        var started = 0;

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Run(Photos(400), recorder, async (item, ct) =>
        {
            Interlocked.Increment(ref started);
            await Task.Delay(1, ct);
            return item;
        }, apply: _ => throw new InvalidOperationException("window closed")));

        Assert.Equal("window closed", error.Message);
        Assert.True(started < 400);
    }

    [Fact]
    public async Task The_second_pass_returns_at_once_runs_one_photo_at_a_time_and_survives_a_failure()
    {
        var order = new ConcurrentQueue<int>();
        var failures = new ConcurrentQueue<int>();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var overlap = 0;
        var overlapped = false;

        var pass = LibraryHydration.RunInBackground(Photos(5), async (item, ct) =>
        {
            if (Interlocked.Increment(ref overlap) > 1) overlapped = true;
            await release.Task.WaitAsync(Patience, ct);
            order.Enqueue(item);
            Interlocked.Decrement(ref overlap);
            if (item == 2) throw new InvalidOperationException("one edited photo failed");
        }, (item, error) => failures.Enqueue(item), CancellationToken.None);

        Assert.False(pass.IsCompleted);
        release.SetResult();
        await pass.WaitAsync(Patience);

        Assert.Equal(Photos(5), order.ToArray());
        Assert.Equal(new[] { 2 }, failures.ToArray());
        Assert.False(overlapped);
    }

    [Fact]
    public async Task The_second_pass_stops_quietly_when_cancelled()
    {
        using var cts = new CancellationTokenSource();
        var ran = new List<int>();

        await LibraryHydration.RunInBackground(Photos(50), (item, ct) =>
        {
            ran.Add(item);
            if (item == 3) cts.Cancel();
            return Task.CompletedTask;
        }, (item, error) => Assert.Fail("cancellation is not a failure"), cts.Token).WaitAsync(Patience);

        Assert.Equal(new[] { 0, 1, 2, 3 }, ran);
    }

    [Fact]
    public async Task The_first_fill_is_complete_before_a_blocked_second_pass_has_anything_to_wait_for()
    {
        var recorder = new Recorder();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondPassStarted = false;

        await Run(Photos(30), recorder, (item, ct) => Task.FromResult(item));
        var pass = LibraryHydration.RunInBackground(Photos(30), async (item, ct) =>
        {
            secondPassStarted = true;
            await release.Task.WaitAsync(Patience, ct);
        }, recorder.Fail, CancellationToken.None);

        Assert.Equal(30, recorder.Batches.Sum(batch => batch.Length));
        Assert.Equal("after", recorder.Events[^1]);
        Assert.False(pass.IsCompleted);
        release.SetResult();
        await pass.WaitAsync(Patience);
        Assert.True(secondPassStarted);
    }

    [Fact]
    public async Task A_request_from_outside_the_fill_gets_a_render_slot_without_waiting()
    {
        var recorder = new Recorder();
        var holding = 0;
        var allSlotsOfTheFillHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        var fill = Run(Photos(20), recorder, async (item, ct) =>
        {
            await RenderGate.Slots.WaitAsync(ct);
            try
            {
                if (Interlocked.Increment(ref holding) == LibraryHydration.Width) allSlotsOfTheFillHeld.TrySetResult();
                await release.Task.WaitAsync(Patience, ct);
            }
            finally { RenderGate.Slots.Release(); }
            return item;
        });
        await allSlotsOfTheFillHeld.Task.WaitAsync(Patience);

        var gotSlot = await RenderGate.Slots.WaitAsync(0);
        if (gotSlot) RenderGate.Slots.Release();
        release.SetResult();
        await fill.WaitAsync(Patience);

        Assert.True(gotSlot);
    }

    [Fact]
    public async Task Running_out_of_memory_ends_the_run_instead_of_being_skipped_as_one_failed_photo()
    {
        var recorder = new Recorder();

        await Assert.ThrowsAsync<OutOfMemoryException>(() => Run(Photos(20), recorder, (item, ct) =>
            item == 5 ? throw new OutOfMemoryException() : Task.FromResult(item)));

        Assert.Empty(recorder.Failures);
    }

    [Fact]
    public async Task Two_overlapping_runs_together_never_have_more_than_three_photos_in_flight_and_a_slot_stays_free()
    {
        var inFlight = 0;
        var maxInFlight = 0;
        var holding = 0;
        var threeHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<int> HeldWork(int item, CancellationToken ct)
        {
            var now = Interlocked.Increment(ref inFlight);
            lock (this) maxInFlight = Math.Max(maxInFlight, now);
            await RenderGate.Slots.WaitAsync(ct);
            try
            {
                if (Interlocked.Increment(ref holding) == 3) threeHeld.TrySetResult();
                await release.Task.WaitAsync(Patience, ct);
            }
            finally
            {
                RenderGate.Slots.Release();
                Interlocked.Decrement(ref inFlight);
            }
            return item;
        }

        var first = Run(Photos(10), new Recorder(), HeldWork);
        var second = Run(Photos(10), new Recorder(), HeldWork);
        await threeHeld.Task.WaitAsync(Patience);
        await Task.Delay(50);

        var gotSlot = await RenderGate.Slots.WaitAsync(0);
        if (gotSlot) RenderGate.Slots.Release();
        var seenWhileHeld = Volatile.Read(ref maxInFlight);
        release.SetResult();
        await Task.WhenAll(first, second).WaitAsync(Patience);

        Assert.Equal(3, seenWhileHeld);
        Assert.True(gotSlot);
    }

    [Fact]
    public async Task The_second_pass_waits_for_the_same_admission_as_a_fill()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var holding = 0;
        var threeHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fill = Run(Photos(6), new Recorder(), async (item, ct) =>
        {
            if (Interlocked.Increment(ref holding) == 3) threeHeld.TrySetResult();
            await release.Task.WaitAsync(Patience, ct);
            return item;
        });
        await threeHeld.Task.WaitAsync(Patience);
        var stepStarted = false;

        var pass = LibraryHydration.RunInBackground(Photos(1), (item, ct) => { stepStarted = true; return Task.CompletedTask; },
            (item, error) => Assert.Fail("no failure expected"), CancellationToken.None);
        await Task.Delay(100);
        var startedWhileFillHeldEverySlot = stepStarted;
        release.SetResult();
        await Task.WhenAll(fill, pass).WaitAsync(Patience);

        Assert.False(startedWhileFillHeldEverySlot);
        Assert.True(stepStarted);
    }
}
